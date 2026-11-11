'use client';

// The swap form, driven only by the public API:
//
//   currency pickers   GET /currencies, GET /sources
//   live offer         POST /quote (debounced, renewed when it expires)
//   Review order       POST /addresses/validate (advisory format check)
//   Create order       POST /orders with an Idempotency-Key, then /orders/{id}
//
// Display requirements: Kotova X by name and icon next to the offer, and the
// source notice (plus the fallback sources' notices) visible before the user
// creates the order. https://docs.kotova.io/x/api/display-requirements
//
// Creating an order follows the API's retry rule: after a timeout, a dropped
// connection or a 5xx without a definitive answer, the same body is sent again
// with the same Idempotency-Key (so no second order can be created), with a
// growing pause. From then on only an answer that settles the request ends
// it (a 201, or an error the API gives after checking the key: see
// settlesOrderRequest in errors.ts); a rate limit or an outage is waited out
// and asked again, and any other answer keeps the outcome unknown. When the
// retries run out, or the API says the source may hold the order, the form
// enters "outcome unknown": the key is kept, the offer is no longer renewed,
// editing is off, and only "Try again (same request)" or an explicit "Start a
// new swap anyway" lead out of it. The request (body and key, no secrets) is
// stored in localStorage before the first attempt is sent, so a reload or a
// closed tab at any point comes back to "outcome unknown", for the 24 h the
// API keeps the key.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import ApiIcon from './ApiIcon';
import AssetPicker from './AssetPicker';
import Field from './Field';
import KotovaXMark from './KotovaXMark';
import RecentOrders from './RecentOrders';
import SourceFilter, { MAX_EXCLUDED } from './SourceFilter';
import { SourceNotices } from './SourceNotice';
import { useCatalog } from '@/lib/kx/use-catalog';
import { defaultAmount, legKey, maxFractionDigits, servingSources, type Leg } from '@/lib/kx/catalog';
import { kx, KxError, newIdempotencyKey, UI_LANG } from '@/lib/kx/client';
import { describeKxError, settlesOrderRequest, type DescribedError, type ErrorField } from '@/lib/kx/errors';
import { cleanAmountInput, invertRate, toRequestAmount, trimAmount } from '@/lib/kx/decimal';
import { rememberOrder } from '@/lib/kx/recent-orders';
import { fallbacksNeedingRefund } from '@/lib/kx/refund';
import { formatDuration, formatTime, shortAddress } from '@/lib/format';
import { readListPref, readPref, writePref } from '@/lib/prefs';
import { SUPPORT_CONTACT } from '@/lib/support';
import type { AddressField, Order, OrderRequest, Quote, RateType } from '@/lib/kx/types';

type Step = 'edit' | 'checking' | 'review' | 'submitting';
type FieldMessages = Partial<Record<ErrorField, string>>;

/** An order request whose outcome is not known yet. */
interface PendingOrder {
  /** Exactly what was sent, with its key: "Try again" sends both unchanged. */
  body: OrderRequest;
  key: string;
  /**
   * in_flight: stored before the first attempt is sent, and only in storage
   * (read back after a reload or a closed tab, it is no_answer).
   * no_answer: no definitive answer (the order may or may not exist).
   * source_unknown: the API says the source may hold the order
   * (source_error outcome_unknown): contact support.
   */
  kind: 'in_flight' | 'no_answer' | 'source_unknown';
  message: string;
  /** The last request id the API gave for it, if any. */
  requestId: string | null;
  /** "0.01 BTC → about 0.25 ETH to 0x1234...abcd" */
  summary: string;
  at: number;
}

const PENDING_PREF = 'pending_order';
/** The API keeps an Idempotency-Key for 24 hours. */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Pauses before each repeat of POST /orders with the same key (seconds); then "outcome unknown". */
const RETRY_PAUSES_S = [2, 4, 8, 15, 30];
/** The longest pause, also when Retry-After asks for more. */
const MAX_PAUSE_S = 120;

/** The stored request, as stored (or null when there is none or it is unreadable). */
function storedPending(): Partial<PendingOrder> | null {
  const raw = readPref(PENDING_PREF);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === 'object' ? (p as Partial<PendingOrder>) : null;
  } catch {
    return null;
  }
}

/** The stored request with an unknown outcome, if one is still within the key's 24 h. */
function readPending(): PendingOrder | null {
  const p = storedPending();
  if (!p) {
    writePref(PENDING_PREF, null);
    return null;
  }
  const fresh = typeof p.at === 'number' && Date.now() - p.at < PENDING_MAX_AGE_MS;
  const shaped =
    !!p.body &&
    typeof p.body === 'object' &&
    typeof p.body.quote_id === 'string' &&
    typeof p.key === 'string' &&
    (p.kind === 'in_flight' || p.kind === 'no_answer' || p.kind === 'source_unknown');
  if (!fresh || !shaped) {
    writePref(PENDING_PREF, null);
    return null;
  }
  const base = {
    body: p.body as OrderRequest,
    key: p.key as string,
    requestId: typeof p.requestId === 'string' ? p.requestId : null,
    summary: String(p.summary ?? ''),
    at: p.at as number,
  };
  // Sent, but the answer never reached this page.
  if (p.kind === 'in_flight') {
    return {
      ...base,
      kind: 'no_answer',
      message: 'The answer to this order request was not received: the page was reloaded or closed, or another tab is still waiting for it.',
    };
  }
  return { ...base, kind: p.kind as PendingOrder['kind'], message: String(p.message ?? '') };
}

function savePending(p: PendingOrder): void {
  writePref(PENDING_PREF, JSON.stringify(p));
}

/** Drop the stored request once it is settled, unless another tab has stored its own since. */
function forgetPending(key: string): void {
  const p = storedPending();
  if (!p || p.key === key) writePref(PENDING_PREF, null);
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

const QUOTE_DEBOUNCE_MS = 400;
const DEFAULT_PAIRS: [string, string][] = [
  ['BTC|btc', 'ETH|eth'],
  ['BTC|btc', 'USDT|trx'],
  ['ETH|eth', 'BTC|btc'],
];

function quoteMatches(quote: Quote, from: Leg, to: Leg, rateType: RateType): boolean {
  return (
    quote.from.currency.toUpperCase() === from.currency &&
    quote.from.network.toLowerCase() === from.network &&
    quote.to.currency.toUpperCase() === to.currency &&
    quote.to.network.toLowerCase() === to.network &&
    quote.rate_type === rateType
  );
}

export default function SwapForm() {
  const router = useRouter();
  const { catalog, error: catalogError, loading: catalogLoading, retry: retryCatalog } = useCatalog();

  // ------------------------------------------------------------------ preferences
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [rateType, setRateTypeState] = useState<RateType>('fixed');
  const [freezeProtection, setFreezeProtection] = useState(false);
  const [retryFallback, setRetryFallback] = useState(true);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());

  // An order request with an unknown outcome blocks the form (see the top of
  // this file). The state never holds an in_flight request: storage does.
  const [pending, setPendingState] = useState<PendingOrder | null>(null);
  const pendingRef = useRef<PendingOrder | null>(null);
  pendingRef.current = pending;
  const showPending = (next: PendingOrder | null) => {
    pendingRef.current = next;
    setPendingState(next);
  };

  useEffect(() => {
    const rt = readPref('rate_type');
    if (rt === 'fixed' || rt === 'variable') setRateTypeState(rt);
    setFreezeProtection(readPref('freeze_protection') === 'true');
    setRetryFallback(readPref('retry_next_best_source') !== 'false');
    setExcluded(new Set(readListPref('exclude_sources').slice(0, MAX_EXCLUDED)));
    const restored = readPending();
    pendingRef.current = restored;
    setPendingState(restored);
    setPrefsLoaded(true);
  }, []);

  const setRateType = (next: RateType) => {
    setRateTypeState(next);
    writePref('rate_type', next);
  };
  // Freeze protection keeps only sources that cannot freeze funds. If none of
  // them offers a fixed rate (today the only one, Chainflip, is variable only),
  // a fixed-rate quote can never succeed, so switching freeze protection on
  // also switches to the variable rate. Only on that click: a stored "fixed"
  // is never changed on page load.
  const toggleFreeze = (on: boolean) => {
    setFreezeProtection(on);
    writePref('freeze_protection', on ? 'true' : null);
    const fixedWithoutFreeze = !catalog?.sources.some((s) => s.freeze_protection && s.rate_types.includes('fixed'));
    if (on && rateType === 'fixed' && fixedWithoutFreeze) setRateType('variable');
  };
  const toggleRetry = (on: boolean) => {
    setRetryFallback(on);
    writePref('retry_next_best_source', on ? null : 'false');
  };
  const toggleSource = (slug: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else if (next.size < MAX_EXCLUDED) next.add(slug);
      writePref('exclude_sources', next.size ? JSON.stringify(Array.from(next)) : null);
      return next;
    });
  };
  const excludedList = useMemo(() => Array.from(excluded).sort(), [excluded]);
  const excludedKey = excludedList.join(',');

  // ------------------------------------------------------------------ pair and amount
  const [fromKey, setFromKey] = useState<string | null>(null);
  const [toKey, setToKey] = useState<string | null>(null);
  const from = (fromKey && catalog?.byKey.get(fromKey)) || null;
  const to = (toKey && catalog?.byKey.get(toKey)) || null;
  const [amount, setAmount] = useState('');
  const [amountSide, setAmountSide] = useState<'from' | 'to'>('from');
  const amountTypedRef = useRef(false);
  const [picker, setPicker] = useState<'from' | 'to' | null>(null);
  const closePicker = useCallback(() => setPicker(null), []);

  // The first pair, once the catalogue is in: a deep link
  // (?from=BTC&from_network=btc&to=ETH&to_network=eth&amount=0.1), a default
  // pair, or the first two usable legs.
  useEffect(() => {
    if (!catalog || fromKey) return;
    let f: Leg | undefined;
    let t: Leg | undefined;
    let linkAmount: string | null = null;
    try {
      const q = new URLSearchParams(window.location.search);
      const fc = q.get('from');
      const fn = q.get('from_network');
      const tc = q.get('to');
      const tn = q.get('to_network');
      if (fc && fn) f = catalog.byKey.get(legKey(fc, fn));
      if (tc && tn) t = catalog.byKey.get(legKey(tc, tn));
      linkAmount = q.get('amount') ? cleanAmountInput(q.get('amount') ?? '') : null;
    } catch {
      // No usable deep link.
    }
    if (!f?.send || !t?.receive || f.key === t.key) {
      f = undefined;
      t = undefined;
      for (const [a, b] of DEFAULT_PAIRS) {
        const fa = catalog.byKey.get(a);
        const tb = catalog.byKey.get(b);
        if (fa?.send && tb?.receive) {
          f = fa;
          t = tb;
          break;
        }
      }
    }
    if (!f || !t) {
      f = catalog.legs.find((l) => l.send);
      t = catalog.legs.find((l) => l.receive && l.currency !== f?.currency);
    }
    if (!f || !t) return;
    setFromKey(f.key);
    setToKey(t.key);
    setAmountSide('from');
    setAmount(linkAmount || defaultAmount(f));
    amountTypedRef.current = !!linkAmount;
  }, [catalog, fromKey]);

  const nameOf = useCallback((slug: string) => catalog?.sourceBySlug.get(slug)?.name ?? slug, [catalog]);

  const noServingSource = !!from && !!to && servingSources(from, to, excluded).length === 0;

  // ------------------------------------------------------------------ the quote
  const [quote, setQuote] = useState<Quote | null>(null);
  /** expires_at on this browser's clock (corrected by the API's Date header). */
  const [quoteExpiresAt, setQuoteExpiresAt] = useState<number | null>(null);
  const [quoteError, setQuoteError] = useState<DescribedError | null>(null);
  const [quoteErrorRaw, setQuoteErrorRaw] = useState<KxError | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteNonce, setQuoteNonce] = useState(0);
  const [step, setStep] = useState<Step>('edit');
  const stepRef = useRef<Step>('edit');
  stepRef.current = step;

  useEffect(() => {
    if (!prefsLoaded || !from || !to) return;
    // No new offer while an order is being created or its outcome is unknown.
    if (stepRef.current === 'submitting' || stepRef.current === 'checking' || pendingRef.current) return;
    const typedLeg = amountSide === 'from' ? from : to;
    const requestAmount = toRequestAmount(amount, maxFractionDigits(typedLeg));
    if (!requestAmount || noServingSource) {
      setQuote(null);
      setQuoteError(null);
      setQuoteErrorRaw(null);
      setQuoting(false);
      return;
    }
    const ctrl = new AbortController();
    setQuoting(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await kx.quote(
          {
            from: { currency: from.currency, network: from.network },
            to: { currency: to.currency, network: to.network },
            amount: requestAmount,
            amount_type: amountSide,
            rate_type: rateType,
            ...(excludedList.length ? { exclude_sources: excludedList } : {}),
            ...(freezeProtection ? { freeze_protection: true } : {}),
            lang: UI_LANG,
          },
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        const apiNow = Date.parse(res.headers.get('x-kx-api-date') ?? '');
        const skew = Number.isFinite(apiNow) ? apiNow - Date.now() : 0;
        // The Date header has a 1 s resolution: ignore differences below 2 s.
        setQuoteExpiresAt(Date.parse(res.data.expires_at) - (Math.abs(skew) > 2000 ? skew : 0));
        setQuote(res.data);
        setQuoteError(null);
        setQuoteErrorRaw(null);
      } catch (err) {
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
        setQuote(null);
        setQuoteError(describeKxError(err, nameOf));
        setQuoteErrorRaw(err instanceof KxError ? err : null);
        // Ask again once the API says it may (rate limit, sources unreachable).
        if (err instanceof KxError && (err.code === 'sources_unavailable' || err.code === 'rate_limited') && err.retryAfterSeconds) {
          window.setTimeout(() => setQuoteNonce((n) => n + 1), Math.min(err.retryAfterSeconds, 120) * 1000);
        }
      } finally {
        if (!ctrl.signal.aborted) setQuoting(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
    // nameOf only shapes error text; it must not trigger a new quote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefsLoaded, from?.key, to?.key, amount, amountSide, rateType, excludedKey, freezeProtection, noServingSource, quoteNonce]);

  // A quote is usable until expires_at: then ask for a new one (only while the
  // page is visible, to spare the API budget).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const expiresIn = quote && quoteExpiresAt !== null ? Math.max(0, Math.ceil((quoteExpiresAt - now) / 1000)) : null;
  const quoteExpired = expiresIn !== null && expiresIn <= 0;
  useEffect(() => {
    if (!quoteExpired || step === 'submitting' || step === 'checking' || pending) return;
    if (document.visibilityState === 'visible') {
      setQuoteNonce((n) => n + 1);
      return;
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') setQuoteNonce((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [quoteExpired, step, pending]);

  // The quote on screen must be for the pair and rate type on screen.
  const liveQuote = quote && from && to && quoteMatches(quote, from, to, rateType) ? quote : null;

  // ------------------------------------------------------------------ addresses
  const [address, setAddress] = useState('');
  const [memo, setMemo] = useState('');
  const [refundAddress, setRefundAddress] = useState('');
  const [refundMemo, setRefundMemo] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldMessages>({});
  const [fieldWarnings, setFieldWarnings] = useState<FieldMessages>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const waitSeconds = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  const idemRef = useRef<{ body: string; key: string } | null>(null);
  const checkCache = useRef(new Map<string, { valid: boolean | null; memoValid: boolean | null }>());

  const clearField = (...fields: ErrorField[]) => {
    setFieldErrors((prev) => {
      const next = { ...prev };
      fields.forEach((f) => delete next[f]);
      return next;
    });
    setFieldWarnings((prev) => {
      const next = { ...prev };
      fields.forEach((f) => delete next[f]);
      return next;
    });
  };

  // A refund address belongs to the send network: clear it when that changes.
  const fromNetwork = from?.network ?? null;
  useEffect(() => {
    setRefundAddress('');
    setRefundMemo('');
    const drop = (prev: FieldMessages) => {
      const next = { ...prev };
      delete next.refund_address;
      delete next.refund_memo;
      return next;
    };
    setFieldErrors(drop);
    setFieldWarnings(drop);
  }, [fromNetwork]);

  const toMemoSupported = liveQuote ? liveQuote.requirements.to_memo === 'optional' : !!to?.memo.supported;
  const refundMemoSupported = liveQuote ? liveQuote.requirements.refund_memo === 'optional' : !!from?.memo.supported;
  const refundRequired = liveQuote?.requirements.refund_address === 'required';
  const fallbacksNeedRefund = liveQuote && retryFallback ? fallbacksNeedingRefund(liveQuote.fallback_sources) : [];

  // ------------------------------------------------------------------ amount handlers
  const onAmountInput = (side: 'from' | 'to', raw: string) => {
    amountTypedRef.current = true;
    setAmountSide(side);
    setAmount(cleanAmountInput(raw));
  };

  const pickLeg = (side: 'from' | 'to', leg: Leg) => {
    setPicker(null);
    if (side === 'from') {
      if (to && leg.key === to.key) setToKey(from?.key ?? null);
      setFromKey(leg.key);
      if (!amountTypedRef.current) {
        setAmountSide('from');
        setAmount(defaultAmount(leg));
      }
    } else {
      if (from && leg.key === from.key) setFromKey(to?.key ?? null);
      setToKey(leg.key);
      clearField('to_address', 'to_memo');
    }
  };

  const swapLegs = () => {
    if (!from || !to) return;
    const quotedTo = liveQuote ? trimAmount(liveQuote.to.amount) : '';
    setFromKey(to.key);
    setToKey(from.key);
    if (quotedTo) {
      setAmountSide('from');
      setAmount(quotedTo);
    }
    clearField('to_address', 'to_memo');
  };

  // ------------------------------------------------------------------ Review order
  /** Advisory format check (POST /addresses/validate); the binding check is made by POST /orders. */
  async function checkAddress(leg: Leg, value: string, memoValue: string, addressField: AddressField, memoField: AddressField) {
    const errors: FieldMessages = {};
    const warnings: FieldMessages = {};
    const key = `${leg.key}|${value}|${memoValue}`;
    let verdict = checkCache.current.get(key);
    if (!verdict) {
      try {
        const res = await kx.validateAddress({ currency: leg.currency, network: leg.network, address: value, memo: memoValue || null });
        verdict = { valid: res.data.valid, memoValid: res.data.memo.supported ? res.data.memo.valid : null };
        checkCache.current.set(key, verdict);
      } catch (err) {
        // Advisory only: on a rate limit or an outage, go on (the order request checks again).
        const d = describeKxError(err, nameOf);
        for (const f of d.fields) if (f === addressField || f === memoField) errors[f] = d.message;
        return { errors, warnings };
      }
    }
    if (verdict.valid === false) errors[addressField] = `This does not look like a ${leg.networkName} address.`;
    else if (verdict.valid === null) warnings[addressField] = `${leg.networkName} has no address format rule here: the source checks the address when the order is created.`;
    if (verdict.memoValid === false) errors[memoField] = `This ${leg.memo.label || 'memo'} is not valid on ${leg.networkName}.`;
    return { errors, warnings };
  }

  const handleReview = async () => {
    if (!from || !to || step !== 'edit' || pending) return;
    setActionError(null);
    setActionInfo(null);
    const toAddr = address.trim();
    const refund = refundAddress.trim();
    const errors: FieldMessages = {};
    if (!toAddr) errors.to_address = `Enter the ${to.ticker} (${to.networkName}) address that receives the swap.`;
    if (refundRequired && !refund) errors.refund_address = `${liveQuote?.source.name ?? 'The source'} needs a refund address for this order.`;
    if (!refund && refundMemo.trim()) errors.refund_address = 'Enter the refund address that goes with this memo.';
    if (Object.keys(errors).length) {
      setFieldErrors(errors);
      return;
    }
    if (!liveQuote || quoteExpired) {
      setQuoteNonce((n) => n + 1);
      return;
    }
    setStep('checking');
    const [recipient, refundCheck] = await Promise.all([
      checkAddress(to, toAddr, toMemoSupported ? memo.trim() : '', 'to_address', 'to_memo'),
      refund ? checkAddress(from, refund, refundMemoSupported ? refundMemo.trim() : '', 'refund_address', 'refund_memo') : null,
    ]);
    const allErrors = { ...recipient.errors, ...(refundCheck?.errors ?? {}) };
    setFieldWarnings({ ...recipient.warnings, ...(refundCheck?.warnings ?? {}) });
    setFieldErrors(allErrors);
    setStep(Object.keys(allErrors).length ? 'edit' : 'review');
  };

  // Edit never leaves an "outcome unknown" state: its buttons replace Edit.
  const handleEdit = () => {
    if (pending) return;
    setStep('edit');
    setActionError(null);
    setActionInfo(null);
  };

  // ------------------------------------------------------------------ Create order
  const tickerOf = (currency: string, network: string) => catalog?.byKey.get(legKey(currency, network))?.ticker ?? currency.toUpperCase();

  /** Keep the order in this browser's list, with what GET /orders/{id} does not repeat. */
  const remember = (order: Order, q: Quote | null) => {
    const fallback = order.warnings.find((w) => w.code === 'source_fallback');
    const quotedSlug = typeof fallback?.quoted_source === 'string' ? fallback.quoted_source : (q?.source.slug ?? order.source.slug);
    rememberOrder({
      id: order.id,
      createdAt: order.created_at,
      from: `${trimAmount(order.from.amount ?? q?.from.amount)} ${tickerOf(order.from.currency, order.from.network)}`,
      to: `${trimAmount(order.to.amount ?? q?.to.amount)} ${tickerOf(order.to.currency, order.to.network)}`,
      source: order.source.name,
      provider: order.provider,
      quotedSource: fallback
        ? { slug: quotedSlug, name: q && quotedSlug === q.source.slug ? q.source.name : nameOf(quotedSlug), reason: String(fallback.reason ?? '') }
        : null,
      warnings: order.warnings.map((w) => ({ code: w.code, message: w.message })),
    });
  };

  /**
   * POST /orders, repeated with the same key and body while the answer is not
   * definitive. `q` is the quote on screen when it is the one in the body.
   * `uncertain`: an earlier attempt with this key may have reached the API
   * ("Try again (same request)").
   */
  const submitOrder = async (request: PendingOrder, q: Quote | null, uncertainAtStart: boolean) => {
    const { body, key } = request;
    const restStep: Step = q ? 'review' : 'edit';
    setStep('submitting');
    setActionError(null);
    setActionInfo(null);
    // Stored before anything is sent: a reload or a closed tab from here on
    // comes back to "outcome unknown" with this key and body.
    savePending(request);

    // True once an attempt may have reached the API without a definitive
    // answer: from then on only an answer that settles the request ends it.
    let uncertain = uncertainAtStart;
    let requestId = request.requestId;
    const settled = () => {
      forgetPending(key);
      showPending(null);
      setActionInfo(null);
    };
    const outcomeUnknown = (kind: 'no_answer' | 'source_unknown', message: string) => {
      const next: PendingOrder = { ...request, kind, message, requestId };
      savePending(next);
      showPending(next);
      setActionInfo(null);
      setStep(restStep);
    };

    for (let attempt = 0; ; attempt++) {
      let order: Order;
      try {
        const res = await kx.createOrder(body, key);
        if (typeof res.data?.id !== 'string') {
          throw new KxError(res.status, { code: 'unreadable_response', message: 'The answer could not be read.', request_id: res.headers.get('x-request-id') }, null);
        }
        order = res.data;
      } catch (err) {
        const d = describeKxError(err, nameOf);
        requestId = d.requestId ?? requestId;
        const withRequest = d.requestId && !d.message.includes(d.requestId) ? `${d.message} (request ${d.requestId})` : d.message;

        if (d.next === 'contact_support') {
          outcomeUnknown('source_unknown', withRequest);
          return;
        }
        // No answer (or none that can be read), or an error inside this app
        // after the request may have gone out: the order may exist.
        if (d.next === 'retry_same_key' || !(err instanceof KxError)) uncertain = true;

        if (uncertain && !settlesOrderRequest(d)) {
          // Repeat with the same key and body: after no answer, and also after
          // a rate limit or an outage, which the API answers before it looks at
          // the key. Anything else (the key refused, this app not configured, an
          // error in this app) leaves the outcome unknown.
          const repeat = d.next === 'retry_same_key' || d.next === 'wait';
          if (repeat && attempt < RETRY_PAUSES_S.length) {
            const pause = Math.min(Math.max(d.retryAfterSeconds ?? 0, RETRY_PAUSES_S[attempt]), MAX_PAUSE_S);
            setActionInfo(
              `${d.message} Asking again in ${pause} s with the same request, so no second order can be created (attempt ${attempt + 2} of ${RETRY_PAUSES_S.length + 1}).`,
            );
            await sleep(pause * 1000);
            continue;
          }
          outcomeUnknown('no_answer', withRequest);
          return;
        }

        // A definitive answer: nothing was created, or an order exists.
        settled();
        const addressFields = d.fields.filter((f): f is AddressField => f !== 'amount');
        if (addressFields.length) {
          const errors: FieldMessages = {};
          addressFields.forEach((f, i) => {
            errors[f] = i === 0 ? d.message : 'Check this field too.';
          });
          setFieldErrors(errors);
          setStep('edit');
          return;
        }
        if (d.next === 'open_order' && d.orderId) {
          router.push(`/orders/${d.orderId}`);
          return;
        }
        setActionError(withRequest);
        setStep(restStep);
        if (d.next === 'requote') {
          idemRef.current = null;
          setQuoteNonce((n) => n + 1);
        } else if (d.next === 'wait' && d.retryAfterSeconds) {
          setWaitUntil(Date.now() + d.retryAfterSeconds * 1000);
        }
        return;
      }

      // 201: the order exists (created now, or by an earlier attempt and answered again).
      settled();
      idemRef.current = null;
      try {
        remember(order, q);
      } catch {
        // The list of recent orders is a convenience: the order page opens by its URL.
      }
      router.push(`/orders/${order.id}`);
      return;
    }
  };

  const handleCreate = async () => {
    const q = liveQuote;
    if (!from || !to || !q || step !== 'review' || pending || waitSeconds > 0) return;
    setActionError(null);
    setActionInfo(null);
    // Another tab of this site may have an order request with an unknown
    // outcome: show it here too instead of starting a second one.
    const elsewhere = readPending();
    if (elsewhere) {
      showPending(elsewhere);
      return;
    }
    if (quoteExpiresAt !== null && quoteExpiresAt <= Date.now()) {
      setActionInfo('The offer expired. A new one is loading: check it and the notices, then create the order.');
      setQuoteNonce((n) => n + 1);
      return;
    }
    const refund = refundAddress.trim();
    const body: OrderRequest = {
      quote_id: q.quote_id,
      to_address: address.trim(),
      ...(toMemoSupported && memo.trim() ? { to_memo: memo.trim() } : {}),
      ...(refund ? { refund_address: refund } : {}),
      ...(refund && refundMemoSupported && refundMemo.trim() ? { refund_memo: refundMemo.trim() } : {}),
      lang: UI_LANG,
      // Omitted means true: the fallback sources' notices are shown with the offer.
      ...(retryFallback ? {} : { retry_next_best_source: false }),
    };
    // Same body, same Idempotency-Key: a retry after a timeout can never create
    // a second order. A new quote or new addresses get a new key.
    const bodyJson = JSON.stringify(body);
    if (!idemRef.current || idemRef.current.body !== bodyJson) idemRef.current = { body: bodyJson, key: newIdempotencyKey() };
    const summary = `${trimAmount(q.from.amount)} ${from.ticker} → ${q.rate_type === 'variable' ? 'about ' : ''}${trimAmount(q.to.amount)} ${to.ticker} to ${shortAddress(body.to_address, 10, 6)}`;
    await submitOrder({ body, key: idemRef.current.key, kind: 'in_flight', message: '', requestId: null, summary, at: Date.now() }, q, false);
  };

  /** "Try again (same request)": the stored body with the stored key, never a new quote. */
  const retryPending = () => {
    const p = pendingRef.current;
    if (!p || step === 'submitting') return;
    void submitOrder(p, liveQuote && liveQuote.quote_id === p.body.quote_id ? liveQuote : null, true);
  };

  /** Leave "outcome unknown" on purpose: a new swap with a new quote and a new key. */
  const startNewSwapAnyway = () => {
    if (step === 'submitting') return;
    if (!window.confirm('The earlier request may have created an order. Start a new swap anyway?')) return;
    if (pendingRef.current) forgetPending(pendingRef.current.key);
    showPending(null);
    idemRef.current = null;
    setActionError(null);
    setActionInfo(null);
    setAddress('');
    setMemo('');
    setRefundAddress('');
    setRefundMemo('');
    setFieldErrors({});
    setFieldWarnings({});
    setStep('edit');
    setQuoteNonce((n) => n + 1);
  };

  // ------------------------------------------------------------------ render
  const locked = step !== 'edit' || !!pending;
  const fromValue = amountSide === 'from' ? amount : liveQuote ? trimAmount(liveQuote.from.amount) : '';
  const toValue = amountSide === 'to' ? amount : liveQuote ? trimAmount(liveQuote.to.amount) : '';
  const amountError = quoteError?.fields.includes('amount') ? quoteError : null;
  const decimalOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? trimAmount(v) : null);
  const minFrom = decimalOrNull(quoteErrorRaw?.code === 'amount_below_min' ? quoteErrorRaw.details.min_from_amount : liveQuote?.limits.min_from_amount);
  const maxFrom = decimalOrNull(quoteErrorRaw?.code === 'amount_above_max' ? quoteErrorRaw.details.max_from_amount : liveQuote?.limits.max_from_amount);
  // A fixed-rate quote failed because some source offers no fixed rate: offer
  // the variable rate in one click (e.g. Chainflip with freeze protection).
  const noSourceReasons = quoteErrorRaw?.code === 'no_source_available' && Array.isArray(quoteErrorRaw.details.reasons) ? quoteErrorRaw.details.reasons : [];
  const variableRateMayHelp =
    rateType === 'fixed' &&
    noSourceReasons.some((r) => typeof r === 'object' && r !== null && (r as { reason?: unknown }).reason === 'rate_type_unsupported');
  const applyAmount = (value: string) => {
    amountTypedRef.current = true;
    setAmountSide('from');
    setAmount(value);
  };
  const duration = formatDuration(liveQuote?.estimated_duration_seconds);
  const canReview = !!liveQuote && !quoting && !quoteExpired && !noServingSource;

  const refundTag = refundRequired ? <span className="tag tag-required">Required</span> : <span className="tag tag-recommended">Recommended</span>;
  const sourceName = liveQuote?.source.name ?? 'the source';
  // Shown only when it says something the user must act on: the source needs
  // the address, or fallback sources are skipped without one.
  const refundHintParts = [
    refundRequired ? `${sourceName} needs a refund address for this order.` : null,
    !refundAddress.trim() && fallbacksNeedRefund.length > 0
      ? `Without a refund address, ${fallbacksNeedRefund.map((f) => f.source.name).join(' and ')} can't be used as a fallback.`
      : null,
  ].filter((part): part is string => part !== null);
  const refundHint = refundHintParts.length > 0 ? refundHintParts.join(' ') : null;

  return (
    <div className="stack">
      {catalogError && !catalog && (
        <div className="alert alert-error spread" role="alert">
          <span>The currency list could not be loaded ({catalogError}).</span>
          <button type="button" className="btn btn-small" onClick={retryCatalog}>
            Try again
          </button>
        </div>
      )}

      <div className="card">
        {/* Amounts */}
        <div className="card-section">
          <div className="spread" style={{ marginBottom: 14 }}>
            <h2>Swap</h2>
            <div className="segmented" role="group" aria-label="Rate type">
              {(['fixed', 'variable'] as const).map((rt) => (
                <button key={rt} type="button" aria-pressed={rateType === rt} disabled={locked} onClick={() => setRateType(rt)}>
                  {rt === 'fixed' ? 'Fixed rate' : 'Variable rate'}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="amount-from">
              You send
            </label>
            <div className="amount-row" aria-invalid={amountError ? 'true' : undefined}>
              <input
                id="amount-from"
                className="amount-input"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder={amountSide === 'to' && quoting ? '...' : '0'}
                value={fromValue}
                disabled={locked || !from}
                onChange={(e) => onAmountInput('from', e.target.value)}
              />
              <button type="button" className="asset-button" disabled={locked || !catalog} onClick={() => setPicker('from')} aria-label="Choose what you send">
                {from ? (
                  <>
                    <ApiIcon icon={from.icon} size={28} placeholder={from.ticker} />
                    <span className="asset-text">
                      <span className="asset-ticker">{from.ticker}</span>
                      <span className="asset-network">{from.networkName}</span>
                    </span>
                  </>
                ) : (
                  <span className="muted">{catalogLoading ? 'Loading...' : 'Choose'}</span>
                )}
              </button>
            </div>
            <div className="amount-meta">
              <span>
                {minFrom && (
                  <>
                    Min{' '}
                    <button type="button" className="btn-link" disabled={locked} onClick={() => applyAmount(minFrom)}>
                      {minFrom}
                    </button>
                  </>
                )}
                {minFrom && maxFrom && ' · '}
                {maxFrom && (
                  <>
                    Max{' '}
                    <button type="button" className="btn-link" disabled={locked} onClick={() => applyAmount(maxFrom)}>
                      {maxFrom}
                    </button>
                  </>
                )}
              </span>
              {amountError && <span className="field-error">{amountError.message}</span>}
            </div>
          </div>

          <div className="swap-direction">
            <button type="button" className="btn btn-small" onClick={swapLegs} disabled={locked || !from || !to} aria-label="Swap send and receive">
              &#8645; Swap
            </button>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="amount-to">
              You receive{rateType === 'variable' && <span className="tag">Estimate</span>}
            </label>
            <div className="amount-row">
              <input
                id="amount-to"
                className="amount-input"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder={amountSide === 'from' && quoting ? '...' : '0'}
                value={toValue}
                disabled={locked || !to}
                onChange={(e) => onAmountInput('to', e.target.value)}
              />
              <button type="button" className="asset-button" disabled={locked || !catalog} onClick={() => setPicker('to')} aria-label="Choose what you receive">
                {to ? (
                  <>
                    <ApiIcon icon={to.icon} size={28} placeholder={to.ticker} />
                    <span className="asset-text">
                      <span className="asset-ticker">{to.ticker}</span>
                      <span className="asset-network">{to.networkName}</span>
                    </span>
                  </>
                ) : (
                  <span className="muted">{catalogLoading ? 'Loading...' : 'Choose'}</span>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Offer: source, Kotova X, facts, notices */}
        <div className="card-section" aria-live="polite">
          <h2 className="section-title">Offer</h2>
          {liveQuote && from && to ? (
            <>
              <div className="row-wrap">
                <span className="quote-source">
                  <ApiIcon icon={liveQuote.source.icon} size={28} />
                  <span className="quote-source-name">{liveQuote.source.name}</span>
                </span>
                <KotovaXMark provider={liveQuote.provider} prefix="via" />
              </div>
              <div className="facts">
                <span className="tabular">
                  1 {from.ticker} = {trimAmount(liveQuote.rate)} {to.ticker}
                </span>
                <span className="tabular">
                  1 {to.ticker} = {invertRate(liveQuote.rate)} {from.ticker}
                </span>
                {expiresIn !== null && <span className="tabular">{quoting ? 'Updating...' : `Offer valid for ${expiresIn} s`}</span>}
                {duration && <span>Typical time {duration}</span>}
              </div>
              {liveQuote.warnings.length > 0 && (
                <ul className="facts" style={{ paddingLeft: 18, margin: '8px 0 0', display: 'block' }}>
                  {liveQuote.warnings.map((w, i) => (
                    <li key={`${w.code}-${i}`} className="field-warning">
                      {w.code === 'end_user_ip_missing'
                        ? `Some sources were skipped because no end-user IP was sent${Array.isArray(w.sources) ? ` (${(w.sources as unknown[]).map((s) => nameOf(String(s))).join(', ')})` : ''}.${
                            process.env.NODE_ENV !== 'production' ? ' Set KOTOVA_END_USER_IP_HEADER, TRUSTED_PROXY_HOPS or (locally) KOTOVA_DEV_END_USER_IP: see the README.' : ''
                          }`
                        : w.message}
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ marginTop: 12 }}>
                <SourceNotices
                  source={liveQuote.source}
                  fallbacks={liveQuote.fallback_sources}
                  fallbackEnabled={retryFallback}
                  fromTicker={from.ticker}
                  toTicker={to.ticker}
                />
              </div>
            </>
          ) : pending ? (
            <p className="muted">No new offer while the outcome of the earlier order request is unknown (see below).</p>
          ) : noServingSource && from && to ? (
            <p className="muted">
              No enabled source serves {from.ticker} ({from.networkName}) to {to.ticker} ({to.networkName}). Switch sources on under Options, or pick another pair.
            </p>
          ) : quoteError && !quoting && !amountError ? (
            <div className="alert alert-error" role="alert">
              {quoteError.message}
              {variableRateMayHelp && (
                <>
                  {' '}
                  <button type="button" className="btn btn-small" onClick={() => setRateType('variable')}>
                    Use the variable rate
                  </button>
                </>
              )}
            </div>
          ) : (
            <p className="muted">
              {quoting
                ? 'Finding the best offer...'
                : amountError
                  ? 'No offer for this amount.'
                  : 'Enter an amount to see the best offer and its source notice.'}
            </p>
          )}
        </div>

        {/* Addresses */}
        <div className="card-section">
          <h2 className="section-title">Addresses</h2>
          <Field
            id="to-address"
            label={to ? `Recipient address (${to.ticker} on ${to.networkName})` : 'Recipient address'}
            error={fieldErrors.to_address}
            warning={fieldWarnings.to_address}
          >
            <input
              id="to-address"
              className="input input-mono"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={address}
              readOnly={locked}
              aria-invalid={fieldErrors.to_address ? 'true' : undefined}
              onChange={(e) => {
                setAddress(e.target.value);
                clearField('to_address');
              }}
            />
          </Field>
          {toMemoSupported && to && (
            <Field id="to-memo" label={`Recipient ${to.memo.label || 'memo'}`} tag={<span className="tag">If needed</span>} error={fieldErrors.to_memo} hint="Only if your wallet or exchange account asks for one.">
              <input
                id="to-memo"
                className="input input-mono"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={memo}
                readOnly={locked}
                aria-invalid={fieldErrors.to_memo ? 'true' : undefined}
                onChange={(e) => {
                  setMemo(e.target.value);
                  clearField('to_memo');
                }}
              />
            </Field>
          )}
          <Field
            id="refund-address"
            label={from ? `Refund address (${from.ticker} on ${from.networkName})` : 'Refund address'}
            tag={refundTag}
            error={fieldErrors.refund_address}
            warning={fieldWarnings.refund_address}
            hint={refundHint}
          >
            <input
              id="refund-address"
              className="input input-mono"
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={refundAddress}
              readOnly={locked}
              required={refundRequired}
              aria-invalid={fieldErrors.refund_address ? 'true' : undefined}
              onChange={(e) => {
                setRefundAddress(e.target.value);
                clearField('refund_address');
              }}
            />
          </Field>
          {refundMemoSupported && from && (
            <Field id="refund-memo" label={`Refund ${from.memo.label || 'memo'}`} tag={<span className="tag">If needed</span>} error={fieldErrors.refund_memo} hint="Needed when the refund address is an exchange account that asks for one.">
              <input
                id="refund-memo"
                className="input input-mono"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={refundMemo}
                readOnly={locked}
                aria-invalid={fieldErrors.refund_memo ? 'true' : undefined}
                onChange={(e) => {
                  setRefundMemo(e.target.value);
                  clearField('refund_memo');
                }}
              />
            </Field>
          )}
        </div>

        {/* Options */}
        <div className="card-section">
          <details className="options">
            <summary>Options</summary>
            <label className="check">
              <input type="checkbox" checked={freezeProtection} disabled={locked} onChange={(e) => toggleFreeze(e.target.checked)} />
              <span>
                Freeze protection
                <span className="hint" style={{ display: 'block' }}>
                  Only sources that cannot freeze funds (<code>freeze_protection</code>).
                </span>
              </span>
            </label>
            <div style={{ marginTop: 14 }}>
              <p className="field-label">Sources</p>
              <SourceFilter sources={catalog?.sources ?? []} excluded={excluded} disabled={locked} onToggle={toggleSource} />
            </div>
          </details>
        </div>

        {/* Review and create */}
        <div className="card-section stack">
          {(step === 'review' || step === 'submitting') && liveQuote && from && to && (
            <>
              <div className="alert alert-info">
                <p>
                  <strong>Check your order</strong>
                </p>
                <ul>
                  <li>
                    You send {trimAmount(liveQuote.from.amount)} {from.ticker} on {from.networkName}.
                  </li>
                  <li>
                    You receive {liveQuote.rate_type === 'variable' ? 'about ' : ''}
                    {trimAmount(liveQuote.to.amount)} {to.ticker} at <span className="mono">{shortAddress(address.trim(), 12, 8)}</span>
                    {toMemoSupported && memo.trim() ? ` (${to.memo.label || 'memo'} ${memo.trim()})` : ''}.
                  </li>
                  <li>
                    {refundAddress.trim() ? (
                      <>
                        Refunds go to <span className="mono">{shortAddress(refundAddress.trim(), 12, 8)}</span>.
                      </>
                    ) : (
                      'No refund address: a refund would need an extra step.'
                    )}
                  </li>
                  <li>
                    Placed with {liveQuote.source.name}
                    {retryFallback && liveQuote.fallback_sources.length > 0 ? ', or with a fallback source listed in the notices above' : ''}, via{' '}
                    <KotovaXMark provider={liveQuote.provider} />
                  </li>
                </ul>
              </div>

              {/* retry_next_best_source: omitted (true) when on, false when off. */}
              <fieldset className="advanced">
                <legend>Advanced</legend>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={retryFallback}
                    disabled={step === 'submitting' || !!pending}
                    onChange={(e) => toggleRetry(e.target.checked)}
                  />
                  <span>
                    Allow fallback to the next best source
                    <span className="hint" style={{ display: 'block' }}>
                      {!retryFallback ? (
                        <>
                          Off: only {liveQuote.source.name} is tried (<code>retry_next_best_source: false</code>).
                        </>
                      ) : liveQuote.fallback_sources.length > 0 ? (
                        `If ${liveQuote.source.name} can't take the order, it is placed with the next of the ${liveQuote.fallback_sources.length} fallback sources whose notices are shown with the offer.`
                      ) : (
                        `This offer has no fallback source: only ${liveQuote.source.name} can take the order.`
                      )}
                    </span>
                  </span>
                </label>
              </fieldset>
            </>
          )}

          {(actionError || actionInfo) && (
            <div className={`alert ${actionError ? 'alert-error' : 'alert-info'}`} role={actionError ? 'alert' : 'status'}>
              {actionError ?? actionInfo}
            </div>
          )}

          {pending ? (
            <div className="stack" style={{ gap: 10 }}>
              <div className="alert alert-warning" role="alert">
                <p>
                  <strong>{pending.kind === 'no_answer' ? 'Outcome unknown: the order may or may not exist' : 'The order may exist at the source'}</strong>
                </p>
                <p>{pending.message}</p>
                {pending.kind === 'no_answer' && (
                  <p style={{ marginTop: 6 }}>
                    Try again with the same request: if the order was created, the API answers with it, and no second order can be created. Do not
                    start a new swap for the same funds before you know. If trying again does not settle it, contact {SUPPORT_CONTACT}
                    {pending.requestId ? ` with request ${pending.requestId}` : ' with the time and summary below'}.
                  </p>
                )}
                {pending.summary && (
                  <p className="small" style={{ marginTop: 6 }}>
                    Request of {formatTime(new Date(pending.at).toISOString())}: {pending.summary}
                  </p>
                )}
              </div>
              <div className="btn-row">
                {pending.kind === 'no_answer' && (
                  <button type="button" className="btn btn-primary" disabled={step === 'submitting'} onClick={retryPending}>
                    {step === 'submitting' ? 'Asking again...' : 'Try again (same request)'}
                  </button>
                )}
                <button type="button" className="btn" disabled={step === 'submitting'} onClick={startNewSwapAnyway}>
                  Start a new swap anyway
                </button>
              </div>
            </div>
          ) : step === 'edit' || step === 'checking' ? (
            <button type="button" className="btn btn-primary" disabled={!canReview || step === 'checking'} onClick={() => void handleReview()}>
              {step === 'checking' ? 'Checking addresses...' : 'Review order'}
            </button>
          ) : (
            <div className="btn-row">
              <button type="button" className="btn" disabled={step === 'submitting'} onClick={handleEdit}>
                Edit
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={step === 'submitting' || !liveQuote || quoting || quoteExpired || waitSeconds > 0}
                onClick={() => void handleCreate()}
              >
                {step === 'submitting' ? 'Creating order...' : waitSeconds > 0 ? `Try again in ${waitSeconds} s` : !liveQuote || quoting || quoteExpired ? 'Updating offer...' : 'Create order'}
              </button>
            </div>
          )}
        </div>
      </div>

      <RecentOrders />

      {picker && catalog && (
        <AssetPicker
          side={picker}
          legs={catalog.legs}
          current={picker === 'from' ? from : to}
          other={picker === 'from' ? to : from}
          excluded={excluded}
          onSelect={(leg) => pickLeg(picker, leg)}
          onClose={closePicker}
        />
      )}
    </div>
  );
}
