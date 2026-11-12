'use client';

// The order page: GET /orders/{id}, polled every 15 s while the tab is
// visible, until `is_final`. Shows what to send (deposit), where the order
// stands (status, status_detail), the transactions, and who executes it: the
// order's source with its notice, and Kotova X as the provider.

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import ApiIcon from './ApiIcon';
import CopyButton from './CopyButton';
import KotovaXMark from './KotovaXMark';
import { NoticeText } from './SourceNotice';
import { useCatalog } from '@/lib/kx/use-catalog';
import { legKey } from '@/lib/kx/catalog';
import { kx, KxError } from '@/lib/kx/client';
import { describeKxError, type DescribedError } from '@/lib/kx/errors';
import { SUPPORT_CONTACT } from '@/lib/support';
import { trimAmount } from '@/lib/kx/decimal';
import { findRecentOrder, type RecentOrder } from '@/lib/kx/recent-orders';
import { refundForwarding, refundOnFileHint } from '@/lib/kx/refund';
import { safeHttpsUrl } from '@/lib/kx/safe-url';
import { formatCountdown, formatDuration, formatTime } from '@/lib/format';
import type { Order, OrderStatus } from '@/lib/kx/types';

const POLL_MS = 15_000;
const ORDER_ID = /^X-[A-Z0-9]{6}$/;

const STATUS_LABEL: Record<OrderStatus, string> = {
  waiting_for_deposit: 'Waiting for deposit',
  confirming_deposit: 'Confirming deposit',
  exchanging: 'Exchanging',
  sending: 'Sending',
  completed: 'Completed',
  action_required: 'Action required',
  refunding: 'Refunding',
  refunded: 'Refunded',
  expired: 'Expired',
};

const STEPS: { status: OrderStatus; label: string }[] = [
  { status: 'waiting_for_deposit', label: 'Deposit' },
  { status: 'confirming_deposit', label: 'Confirming' },
  { status: 'exchanging', label: 'Exchanging' },
  { status: 'sending', label: 'Sending' },
  { status: 'completed', label: 'Completed' },
];

const REASONS: Record<string, { title: string; body: (source: string) => string }> = {
  amount_mismatch: {
    title: 'The deposit does not match the order',
    body: (s) => `${s} received a different amount than expected, or one outside its limits.`,
  },
  late_deposit: {
    title: 'The deposit arrived after the order expired',
    body: (s) => `${s} received the deposit after the deadline.`,
  },
  source_review: {
    title: 'The source is reviewing the order',
    body: (s) => `${s} holds the order for a review and resolves it itself. Nothing to choose: keep this page open.`,
  },
  payout_on_hold: {
    title: 'Payout on hold',
    body: (s) => `${s} reports the swap as done but has not sent the payout yet.`,
  },
  refund_address_rejected: {
    title: 'The refund address was refused',
    body: (s) => `${s} refused the refund address. A new one is needed.`,
  },
  other: {
    title: 'The source reported a problem',
    body: (s) => `${s} reported a problem with this order.`,
  },
};

const FALLBACK_REASON: Record<string, string> = {
  disabled: 'was not available',
  paused: 'was paused',
  busy: 'was busy',
  rejected: 'refused the order',
  unavailable: 'could not create it',
  rate_limited: 'was rate limited',
};

/** "Confirmed" once the source has what it needs (or the order is final), else "2 / 6 confirmations". */
function confirmationsText(confirmations: number | null, required: number | null, isFinal: boolean): string | null {
  if (confirmations == null) return isFinal ? 'Confirmed' : null;
  if (isFinal || (required != null && confirmations >= required)) return 'Confirmed';
  return required != null ? `${confirmations} / ${required} confirmations` : `${confirmations} confirmations`;
}

function tone(status: OrderStatus): 'active' | 'success' | 'warning' | 'neutral' {
  if (status === 'completed') return 'success';
  if (status === 'action_required') return 'warning';
  if (status === 'expired' || status === 'refunded') return 'neutral';
  return 'active';
}

export default function OrderView({ id: rawId }: { id: string }) {
  const id = rawId.toUpperCase();
  const validId = ORDER_ID.test(id);
  const { catalog } = useCatalog();

  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [recent, setRecent] = useState<RecentOrder | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [qrTab, setQrTab] = useState<'address' | 'memo'>('address');
  const timerRef = useRef<number | null>(null);

  useEffect(() => setRecent(findRecentOrder(id)), [id]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  // Poll until is_final. A read may refresh the order from its source first,
  // so 15 s is the polite interval.
  useEffect(() => {
    if (!validId) return;
    let stopped = false;
    const ctrl = new AbortController();
    const schedule = (ms: number) => {
      if (!stopped) timerRef.current = window.setTimeout(load, ms);
    };
    async function load() {
      if (document.visibilityState !== 'visible') {
        schedule(POLL_MS);
        return;
      }
      try {
        const res = await kx.order(id, undefined, ctrl.signal);
        if (stopped) return;
        setOrder(res.data);
        setError(null);
        setNotFound(false);
        setLastUpdated(Date.now());
        if (!res.data.is_final) schedule(POLL_MS);
      } catch (err) {
        if (stopped || (err instanceof DOMException && err.name === 'AbortError')) return;
        if (err instanceof KxError && err.code === 'order_not_found') {
          setNotFound(true);
          return;
        }
        if (err instanceof KxError && err.code === 'order_archived') {
          // 90 days after creation the API stops returning the order for good:
          // drop what is on screen (its deposit details no longer apply), say
          // so, and stop polling — also on a later tab refocus.
          timerRef.current = null;
          setOrder(null);
          setError(describeKxError(err));
          return;
        }
        setError(describeKxError(err));
        const wait = err instanceof KxError && err.retryAfterSeconds ? err.retryAfterSeconds * 1000 : POLL_MS * 2;
        schedule(Math.max(wait, POLL_MS));
      }
    }
    void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      ctrl.abort();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [id, validId]);

  // Names and icons from the catalogue (the order carries identifiers only).
  const legInfo = (currency: string, network: string) => {
    const leg = catalog?.byKey.get(legKey(currency, network)) ?? null;
    return {
      ticker: leg?.ticker ?? currency.toUpperCase(),
      networkName: leg?.networkName ?? network,
      icon: leg?.icon ?? null,
    };
  };

  const quotedSource = useMemo(() => {
    if (!order || !recent?.quotedSource) return null;
    return recent.quotedSource.slug === order.source.slug ? null : recent.quotedSource;
  }, [order, recent]);

  if (!validId || notFound) {
    return (
      <div className="stack">
        <h1>Order not found</h1>
        <p className="muted">
          {validId
            ? 'This app opens only the orders created in this browser, and this one is not among them (or it does not exist).'
            : 'Order ids look like X-AB12CD.'}
        </p>
        <p>
          <Link href="/" className="btn">
            New swap
          </Link>
        </p>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="stack">
        <h1>
          Order <span className="mono">{id}</span>
        </h1>
        {error ? (
          <div className="alert alert-error" role="alert">
            {error.message}
          </div>
        ) : (
          <p className="muted">Loading the order...</p>
        )}
      </div>
    );
  }

  const from = legInfo(order.from.currency, order.from.network);
  const to = legInfo(order.to.currency, order.to.network);
  const secondsLeft = order.expires_at ? (Date.parse(order.expires_at) - now) / 1000 : null;
  const stepIndex = STEPS.findIndex((s) => s.status === order.status);
  const detail = order.status_detail;
  const reason = detail ? REASONS[detail.reason] ?? REASONS.other : null;
  // GET /sources says how the order's source uses a refund address.
  const forwarding = refundForwarding(catalog?.sourceBySlug.get(order.source.slug));
  const depositTx = order.transactions.deposit;
  const memoLabel = order.deposit.memo_label || 'Memo';
  const createWarnings = (recent?.warnings ?? []).filter((w) => w.code !== 'source_fallback');
  // Links from the API are used only when they are https.
  const resolveUrl = safeHttpsUrl(detail?.resolve_url);
  const trackingUrl = safeHttpsUrl(order.source.tracking_url);
  const orderUrl = safeHttpsUrl(order.order_url);

  return (
    <div className="stack">
      <div className="spread" style={{ flexWrap: 'wrap' }}>
        <h1>
          Order <span className="mono">{order.id}</span>
        </h1>
        <span className="status-badge" data-tone={tone(order.status)}>
          {STATUS_LABEL[order.status]}
          {order.is_final ? ' (final)' : ''}
        </span>
      </div>

      {quotedSource && (
        <div className="alert alert-info">
          {quotedSource.name} {FALLBACK_REASON[quotedSource.reason] ?? 'could not take the order'}, so it was placed with {order.source.name}, the next best
          source. {order.source.name}&apos;s notice below applies.
        </div>
      )}
      {createWarnings.length > 0 && (
        <div className="alert alert-warning">
          <strong>Notes from order creation</strong>
          <ul>
            {createWarnings.map((w, i) => (
              <li key={`${w.code}-${i}`}>{w.message}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <div className="alert alert-error" role="alert">
          {error.message}
        </div>
      )}

      <div className="card">
        {stepIndex >= 0 && (
          <div className="card-section">
            <ol className="steps" aria-label="Progress">
              {STEPS.map((s, i) => {
                const state = order.status === 'completed' || i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo';
                return (
                  <li key={s.status} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
                    {s.label}
                  </li>
                );
              })}
            </ol>
          </div>
        )}

        {/* What to do now */}
        <div className="card-section">
          {order.status === 'waiting_for_deposit' && order.deposit.address ? (
            <div className="deposit">
              <div className="stack" style={{ gap: 10 }}>
                <p className="muted">Send exactly</p>
                <div className="row-wrap">
                  <span className="deposit-amount">
                    {trimAmount(order.deposit.amount ?? order.from.amount)} {from.ticker}
                  </span>
                  {order.deposit.amount && <CopyButton value={trimAmount(order.deposit.amount)} label="Copy amount" />}
                </div>
                <p className="muted">on {from.networkName} to</p>
                <div className="copy-line">
                  <span className="mono">{order.deposit.address}</span>
                  <CopyButton value={order.deposit.address} />
                </div>
                {order.deposit.memo && (
                  <>
                    <p className="field-label">
                      {memoLabel} <span className="tag tag-required">Required</span>
                    </p>
                    <div className="copy-line">
                      <span className="mono">{order.deposit.memo}</span>
                      <CopyButton value={order.deposit.memo} />
                    </div>
                    <div className="alert alert-error">
                      Send the {memoLabel} with your deposit. Without it, the deposit cannot be matched to this order.
                    </div>
                  </>
                )}
                {secondsLeft !== null && (
                  <p className="tabular">
                    Time left: <strong>{formatCountdown(secondsLeft)}</strong>
                  </p>
                )}
                <p className="small muted">
                  {order.rate_type === 'variable'
                    ? 'Variable rate: the amount you receive is set when your deposit arrives.'
                    : 'Fixed rate: you receive the amount shown below if the deposit arrives in time.'}
                </p>
              </div>
              <div className="qr">
                <div className="qr-frame">
                  <QRCodeSVG
                    value={qrTab === 'memo' && order.deposit.memo ? order.deposit.memo : order.deposit.address}
                    size={168}
                    level="M"
                    bgColor="#ffffff"
                    fgColor="#000000"
                  />
                </div>
                {order.deposit.memo && (
                  <div className="segmented" role="group" aria-label="QR code content">
                    <button type="button" aria-pressed={qrTab === 'address'} onClick={() => setQrTab('address')}>
                      Address
                    </button>
                    <button type="button" aria-pressed={qrTab === 'memo'} onClick={() => setQrTab('memo')}>
                      {memoLabel}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {order.status === 'action_required' && detail && reason && (
                <div className="alert alert-warning">
                  <p>
                    <strong>{reason.title}</strong>
                  </p>
                  <p>{reason.body(order.source.name)}</p>
                  {detail.reason === 'payout_on_hold' && !resolveUrl && (
                    <p style={{ marginTop: 6 }}>
                      Contact {SUPPORT_CONTACT} with the order id {order.id}.
                    </p>
                  )}
                  {detail.auto_resolution && (
                    <p style={{ marginTop: 6 }}>
                      {detail.auto_resolution === 'refund'
                        ? `If nobody chooses, the deposit is refunded${order.refund.address ? ` to ${order.refund.address}` : ''} at ${formatTime(detail.auto_resolution_at)}.`
                        : `If nobody chooses, the swap continues at the source's current rate at ${formatTime(detail.auto_resolution_at)}.`}
                    </p>
                  )}
                  {!detail.auto_resolution && resolveUrl && <p style={{ marginTop: 6 }}>Nothing happens on its own: a choice is needed.</p>}
                  {resolveUrl && (
                    <p style={{ marginTop: 10 }}>
                      <a className="btn btn-primary" href={resolveUrl} target="_blank" rel="noopener noreferrer">
                        Choose how to proceed
                      </a>
                    </p>
                  )}
                </div>
              )}
              {order.status === 'refunding' && reason && <p className="muted">{reason.title}.</p>}
              {order.status === 'expired' && (
                <>
                  <p>No deposit arrived in time.</p>
                  {!order.is_final && <p className="muted">If you did send funds, keep this page open: a late deposit can still revive the order.</p>}
                  <p>
                    <Link href="/" className="btn">
                      New swap
                    </Link>
                  </p>
                </>
              )}
              {order.status === 'completed' && (
                <p>
                  {trimAmount(order.to.amount_sent ?? order.to.amount)} {to.ticker} was sent.
                </p>
              )}
              {order.status === 'refunded' && <p>The deposit was refunded.</p>}
              {(order.status === 'confirming_deposit' || order.status === 'exchanging' || order.status === 'sending') && (
                <p className="muted">
                  {STATUS_LABEL[order.status]}.
                  {formatDuration(order.estimated_duration_seconds) ? ` Usually ${formatDuration(order.estimated_duration_seconds)} from deposit to payout.` : ''}
                </p>
              )}

              {(depositTx || order.transactions.payout || order.transactions.refund) && (
                <div>
                  {depositTx && (
                    <Tx
                      title="Deposit"
                      hash={depositTx.hash}
                      url={depositTx.explorer_url}
                      extra={confirmationsText(depositTx.confirmations, depositTx.required_confirmations, order.is_final)}
                    />
                  )}
                  {order.transactions.payout && <Tx title="Payout" hash={order.transactions.payout.hash} url={order.transactions.payout.explorer_url} extra={null} />}
                  {order.transactions.refund && <Tx title="Refund" hash={order.transactions.refund.hash} url={order.transactions.refund.explorer_url} extra={null} />}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Details */}
        <div className="card-section">
          <h2 className="section-title">Details</h2>
          <dl className="details">
            <dt>You send</dt>
            <dd className="row">
              <ApiIcon icon={from.icon} size={20} placeholder={from.ticker} />
              <span>
                {trimAmount(order.from.amount_received ?? order.from.amount) || '-'} {from.ticker} <span className="faint">on {from.networkName}</span>
              </span>
            </dd>
            <dt>You receive</dt>
            <dd className="row">
              <ApiIcon icon={to.icon} size={20} placeholder={to.ticker} />
              <span>
                {order.rate_type === 'variable' && !order.to.amount_sent ? 'about ' : ''}
                {trimAmount(order.to.amount_sent ?? order.to.amount) || '-'} {to.ticker} <span className="faint">on {to.networkName}</span>
              </span>
            </dd>
            <dt>Rate</dt>
            <dd>{order.rate_type === 'variable' ? 'Variable' : 'Fixed'}</dd>
            <dt>Recipient</dt>
            <dd>
              <span className="mono">{order.to.address}</span>
              {order.to.memo && <span className="mono faint"> · {order.to.memo}</span>}
            </dd>
            <dt>Refund address</dt>
            <dd>
              {order.refund.address ? (
                <>
                  <span className="mono">{order.refund.address}</span>
                  {order.refund.memo && <span className="mono faint"> · {order.refund.memo}</span>}
                  <span className="hint" style={{ display: 'block' }}>
                    {order.refund.forwarded ? `Sent to ${order.source.name} with the order.` : refundOnFileHint(order.source.name, forwarding)}
                  </span>
                </>
              ) : (
                <span className="faint">None. A refund would need an extra step.</span>
              )}
            </dd>
            <dt>Created</dt>
            <dd>{formatTime(order.created_at)}</dd>
            {order.completed_at && (
              <>
                <dt>Completed</dt>
                <dd>{formatTime(order.completed_at)}</dd>
              </>
            )}
            <dt>Source</dt>
            <dd>
              <span className="row">
                <ApiIcon icon={order.source.icon} size={20} />
                {trackingUrl ? (
                  <a href={trackingUrl} target="_blank" rel="noopener noreferrer">
                    {order.source.name}
                  </a>
                ) : (
                  <span>{order.source.name}</span>
                )}
              </span>
              {order.source.order_id && <span className="mono faint small">{order.source.order_id}</span>}
            </dd>
            <dt>Provider</dt>
            <dd>
              <KotovaXMark provider={order.provider} />
            </dd>
            {orderUrl && (
              <>
                <dt>Order page</dt>
                <dd>
                  <a href={orderUrl} target="_blank" rel="noopener noreferrer">
                    Open the hosted order page
                  </a>
                </dd>
              </>
            )}
          </dl>
        </div>
      </div>

      {/* The notice of the source that executes this order */}
      <div className="notice">
        <NoticeText notice={order.source.notice} />
      </div>
      <p className="small faint tabular">
        {order.is_final
          ? 'This order is final: no more updates.'
          : `Updates every ${POLL_MS / 1000} s while this tab is visible. Last update ${lastUpdated ? new Date(lastUpdated).toLocaleTimeString('en') : '-'}.`}
      </p>
    </div>
  );
}

function Tx({ title, hash, url: rawUrl, extra }: { title: string; hash: string; url: string | null; extra: string | null }) {
  const url = safeHttpsUrl(rawUrl);
  return (
    <div className="tx">
      <div className="spread">
        <strong>{title}</strong>
        {extra && <span className="faint tabular">{extra}</span>}
      </div>
      <div className="row" style={{ marginTop: 4, alignItems: 'flex-start' }}>
        <span className="mono" style={{ flex: 1 }}>
          {hash}
        </span>
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer">
            Explorer
          </a>
        )}
      </div>
    </div>
  );
}
