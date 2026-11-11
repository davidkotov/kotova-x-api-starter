# Kotova X API starter

An example integration of the [Kotova X API](https://docs.kotova.io/x/api), and a
starting point for your own. It is a small Next.js app that gets live quotes, creates
orders and tracks them until they finish, with your API key kept on the server.

**Live demo:** Kotova runs this app at https://swapstarter.kotova.io, against the
production API. Orders there are real orders with real funds.

> **Example code, no warranty.** This repository is provided "as is" under the
> [MIT License](LICENSE), without warranty of any kind. Your use of the Kotova X API is
> governed by the [Kotova X API Terms](https://kotova.io/terms/api), not by this license.
> Before you show quotes to users, read the
> [display requirements](https://docs.kotova.io/x/api/display-requirements).

**Every order is a real order at its source.** A quote has no side effects. An order
that nobody funds expires and nothing is owed, but it counts towards your open-order
limit until then. To try the whole flow, use a small amount, send the deposit from a
wallet you control and receive at an address you control.

## Quick start

Requirements: Node.js 22 or later, pnpm 9.

```bash
pnpm install
cp .env.example .env.local   # then set KOTOVA_API_KEY (and APP_SESSION_SECRET)
pnpm dev                     # http://localhost:3020
```

| Script | What it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js, on port 3020 |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | `next lint` |
| `pnpm gen:api` | Regenerates `src/lib/kx/api-types.ts` from `openapi/openapi.v1.json` |
| `pnpm check:api` | Fails when `src/lib/kx/api-types.ts` is out of date with `openapi/openapi.v1.json` |

## Configuration

All settings are read on the server only (`src/lib/kx/server.ts`). Never prefix them
with `NEXT_PUBLIC_`. `.env.example` lists them with comments.

| Variable | Required | What it is |
|---|---|---|
| `KOTOVA_API_KEY` | yes | Your secret key (`ktv_sk_...`), from https://app.kotova.io/account/api. |
| `APP_SESSION_SECRET` | in production | Signs the cookie that lists the orders created in a browser (see [Orders are private to the browser that created them](#orders-are-private-to-the-browser-that-created-them)). At least 32 characters, for example `openssl rand -hex 32`. Without it, `pnpm dev` uses a random one until the dev server stops and logs a warning; in production the proxy answers `proxy_not_configured`. |
| `KOTOVA_API_BASE` | no | The API base URL. Default `https://api.kotova.io/x/v1`. Must be `https://`; plain `http://` is accepted only for a loopback host (`localhost`, `*.localhost`, `127.0.0.1`, `::1`), so the key never travels in cleartext. |
| `APP_ORIGIN` | no | The origin(s) allowed to POST to `/api/kx` (comma-separated, e.g. `https://swap.example.com`). Set it when a proxy in front of the app rewrites the `Host` header. |
| `KOTOVA_END_USER_IP_HEADER` | no | A header your host sets to the visitor's IP. See [End-user IP](#end-user-ip). |
| `TRUSTED_PROXY_HOPS` | no | How many proxies in front of the app append to `X-Forwarded-For`. See [End-user IP](#end-user-ip). |
| `KOTOVA_DEV_END_USER_IP` | no | Development only: a public IP to send as `end_user_ip` from your machine. See [End-user IP](#end-user-ip). |

Outside production the header shows which API host the app calls, and configuration
errors say what is missing. In production (`NODE_ENV=production`) neither is shown to
visitors; the details go to the server log.

## What it does

- **Swap form** (`/`): pick what you send and receive, type the amount on either side,
  choose a fixed or variable rate, and see the best offer as you type. The offer shows
  its source, Kotova X as the provider, the rate, how long the offer is valid and the
  source notices. Then enter the recipient address (and refund address), review, and
  create the order.
- **Review step**: a summary of the order and, visible under **Advanced**, the option
  **Allow fallback to the next best source**. On (the default), the field is left out
  of the request, so `retry_next_best_source` is true and the fallback sources' notices
  are shown with the offer; off sends `retry_next_best_source: false`, so only the
  quote's source is tried. The choice is remembered in the browser.
- **Order page** (`/orders/{id}`): what to send and where (with copy buttons and a QR
  code), progress, transactions with explorer links, what to do when the order needs
  attention, and the notice of the source that executes the order. It refreshes every
  15 seconds until the order is final.
- **Options**: freeze protection and switching sources off. Switching freeze protection
  on also switches to the variable rate when no source that cannot freeze funds offers
  a fixed rate (today Chainflip, variable only), as on app.kotova.io.

## API contract: pinned to /x/v1

- `openapi/openapi.v1.json` is a copy of https://api.kotova.io/x/v1/openapi.json.
- `src/lib/kx/api-types.ts` is generated from it with
  [openapi-typescript](https://openapi-ts.dev) (`pnpm gen:api`). Do not edit it by hand.
  `src/lib/kx/types.ts` gives the shapes short names, and the proxy's list of endpoints
  is checked against the document's paths at compile time.
- `pnpm check:api` regenerates the types into a temporary file and fails when they
  differ from the committed ones.
- CI (`.github/workflows/ci.yml`) runs `pnpm install --frozen-lockfile`, typecheck, lint,
  build and `check:api` on pushes to `main` and on pull requests, on Node.js 22. Its
  actions are pinned to commit SHAs, and Dependabot (`.github/dependabot.yml`) proposes
  updates. A daily job compares the vendored document with the live one and reports a
  difference as a warning, without failing the workflow.

To update: replace `openapi/openapi.v1.json` with the live document, run
`pnpm gen:api`, fix any type errors and commit both files. A new major version of the
API would come with a new base path; this app stays on `/x/v1` until you move it.

## How it uses the API

The browser never calls the API directly. It calls this app's route handler
(`src/app/api/kx/[...path]/route.ts`), which forwards only the endpoints below, adds the
key to the ones that need it, decides `end_user_ip` on the server and refuses
cross-site POSTs (`Sec-Fetch-Site`, `Origin`, `APP_ORIGIN`), POSTs that are not
`Content-Type: application/json`, bodies over 16 KB and a malformed `Idempotency-Key`.
It passes back only JSON (any other answer, such as a load balancer's HTML error page,
becomes a 502 `upstream_invalid_response`), with `Retry-After`, `X-Request-Id`,
`Idempotent-Replayed`, `X-Kotova-Quote-Cache`, `X-Kotova-Status-Refreshed`, the
rate-limit headers (`RateLimit`, `RateLimit-Policy`, `X-RateLimit-Limit`,
`X-RateLimit-Remaining`, `X-RateLimit-Reset`) and `X-Kotova-Weight`.

| Where | Call | Notes |
|---|---|---|
| Currency pickers | `GET /currencies`, `GET /sources` | Cached for 60 s on the server, revalidated with the ETag; when the API fails or rate-limits, the last good copy (up to 1 hour old) is served. `lang` is limited to `en`, `de`, `it`, `es`, `fr`, `ru` (anything else becomes `en`), so the cache stays small. A pair is offered only when an enabled source serves both sides (`send_sources` and `receive_sources`). |
| Live offer | `POST /quote` | Debounced. `amount_type` follows the field you type in. Sends `rate_type`, `exclude_sources`, `freeze_protection` and `lang`; the server adds `end_user_ip` and, if the API refuses it (400 with `details.field: end_user_ip`), asks once more without it. Renewed when `expires_at` passes, counted on the API's clock. |
| Review order | `POST /addresses/validate` | Advisory format check of the recipient and refund addresses (and memos). |
| Create order | `POST /orders` | One `Idempotency-Key` per request body; see [Creating an order safely](#creating-an-order-safely). Fallback sources can take the API up to 90 s: the proxy waits up to 100 s, its function may run 110 s (`maxDuration`) and the browser waits 120 s. |
| Order page | `GET /orders/{id}` | Only for orders created in this browser. Polled every 15 s while the tab is visible, until `is_final`. |

### Orders are private to the browser that created them

`GET /orders/{id}` answers every order of your account, made with any of its keys,
with its addresses and transaction hashes. The proxy holds that key, so it must not
open any id a visitor types. When `POST /orders` creates an order, the proxy adds its
id to an `httpOnly`, `SameSite=Strict` cookie signed with `APP_SESSION_SECRET`
(HMAC-SHA256; the 20 newest ids, 30 days, path `/api/kx/orders`).
`GET /api/kx/orders/{id}` answers `404 order_not_found` for any id that is not in that
cookie, without calling the API. So an order opens in the browser that created it,
and nowhere else; clearing cookies, another browser or a new `APP_SESSION_SECRET`
loses access in this app (the order is not affected; `GET /orders` and your dashboard
still list it).

The cookie is `Secure` over https, and in production (`NODE_ENV=production`, so
`pnpm build && pnpm start`) always, except on a loopback host (`localhost`,
`*.localhost`, `127.0.0.1`, `::1`). A browser drops a `Secure` cookie sent over plain
http, so a production build opened at `http://192.168.x.x:3020` (a phone on your LAN)
creates orders it then cannot open ("This app shows only the orders created in this
browser"). Test a production build over https or on localhost; `pnpm dev` works over
plain http anywhere.

### Creating an order safely

`src/components/SwapForm.tsx` follows the API's retry rule: after a timeout, a dropped
connection or a 500, send the request again with the same key and the same body.

- The same body always gets the same `Idempotency-Key`; a new quote or new addresses
  get a new one.
- Before the first attempt is sent, the request (body and key; no secrets) is stored
  in `localStorage`. It is removed only when the answer is definitive. A reload or a
  closed tab at any point, even while the first attempt is still waiting, comes back
  to **outcome unknown** with **Try again (same request)**.
- Repeated with the same key and body, after pauses of 2, 4, 8, 15 and 30 s
  (or `Retry-After`, when longer): `idempotency_in_progress`, a plain `internal_error`,
  any 5xx without an API error code (a host's 502/504 page), a success status whose
  body cannot be read, `quote_already_used` without `details.order_id` (an order from
  this offer may be in progress), and the proxy's and browser's own timeouts and
  network errors.
- Once an attempt had no definitive answer, only an answer that settles the request
  ends it: a 201 (an earlier attempt's order is answered again), or an error the API
  gives only after it has checked the key (`quote_*`, `invalid_address`,
  `memo_not_supported`, `refund_address_required`, `order_cap_reached`,
  `idempotency_conflict`, `source_unavailable`, `source_error` other than
  `outcome_unknown`, and `internal_error` with `details.order_id` or
  `details.sources_tried`; see `settlesOrderRequest` in `src/lib/kx/errors.ts`).
  `rate_limited` and `service_unavailable` come before that check, so the same request
  is sent again after `Retry-After`, within the same number of attempts. Any other
  answer (a malformed request, the key refused, `affiliate_inactive`, this app not
  configured, an error inside the app) says nothing about the earlier attempt and goes
  to **outcome unknown**, never back to an editable form.
- When the repeats run out, or the API answers `source_error` with
  `reason: outcome_unknown` (the source may hold the order), the form enters
  **outcome unknown**: the key is kept, the offer is no longer renewed, the form can't
  be edited, and the only ways out are **Try again (same request)** (same key, same
  body) and **Start a new swap anyway** (after a confirmation). Edit does not clear
  it, and it is kept for the 24 hours the API keeps the key. When another tab of the
  app is about to create an order, it shows this request instead.
- `internal_error` with `details.sources_tried` created nothing (the quote and key were
  released), so it fetches a new quote instead of repeating; with `details.order_id`
  the order exists and opens.

## Display requirements

| Requirement | Where this app meets it |
|---|---|
| **Kotova X** by name and icon wherever a quote or order is shown | `src/components/KotovaXMark.tsx`, next to the offer, in the review step, on the order page and with the list of recent orders. Name and icon come from the API's `provider` block at runtime: the icon loads from `icon.url` (cdn.kotova.io), with `icon.fallback_url` (assets.kotova.io) as the one retry. No Kotova files are bundled. Name and icon link to the Kotova X app, https://app.kotova.io (`KOTOVA_X_URL`). |
| The quote's **source notice**, word for word, with its link, before the user confirms | `NoticeText` in `src/components/SourceNotice.tsx` renders `notice.text` with `link_text` as the link to `link_url`, in the offer, in the same view as Create order, without an extra click. |
| The **fallback sources' notices** when the order may fall back | An expandable section directly below the quote's notice. With **Allow fallback to the next best source** switched off on the review step, the order is sent with `retry_next_best_source: false` and only the quote's notice applies. |
| After a fallback, the **executing source** | The order page shows the order's `source` and its notice; after a `source_fallback` 201 it also names the quoted source. |
| Source logos | Only from the API: when a source's `icon` is `null`, no logo is shown. No source logos are bundled. |
| Expired quotes | The offer counts down to `expires_at`; buttons turn off and a new quote is fetched when it passes. |

Links and images from the API (notice links, explorer and tracking links,
`order_url`, `status_detail.resolve_url`, icons) are used only when they are
`https://` URLs (`src/lib/kx/safe-url.ts`).

## Refund addresses

The refund address sits in the same form as the recipient address. It is marked
**Recommended**, and **Required** only when the quote says
`requirements.refund_address: "required"`. Where the source accepts it, it travels with
the order, so a refund needs no extra step, and fallback sources that need one stay
eligible. A hint under the field appears only when it asks for action: the source
needs the address, or fallback sources are skipped without one. The order page shows
`refund.forwarded` and, when the address was not sent with the order, what the source
does with it (`refund_address_forwarding`). A refund memo is offered when the quote says
`requirements.refund_memo: "optional"`.

## Errors

`src/lib/kx/errors.ts` turns every API error into a message and a next step, branching
on `code`, never on `message`:

- `invalid_address` marks the input named by `details.field` (`to_address`, `to_memo`,
  `refund_address` or `refund_memo`) and, when the source did not say which, every
  field in `details.fields`. `memo_not_supported`, `refund_address_required` and
  field-level `invalid_request` errors are mapped the same way.
- `quote_expired`, `quote_not_found`, `source_unavailable`, `source_error`
  (`retryable: true`) and `internal_error` with `details.sources_tried` fetch a new
  quote; `details.sources_tried` is listed.
- `idempotency_in_progress`, a plain `internal_error`, other 5xx answers, timeouts and
  `quote_already_used` without `details.order_id` repeat the request with the same key
  (see [Creating an order safely](#creating-an-order-safely)); `quote_already_used`
  never fetches a new quote, since an order from the offer may exist.
- `rate_limited` and `order_cap_reached` count down from `Retry-After`.
- `source_error` with `outcome_unknown` enters the outcome-unknown state: the order may
  exist at the source, so the user is told to contact support instead of creating
  another order.

### Support contact

Where the user needs a person (an order with an unknown outcome, a payout the source
holds, `affiliate_inactive`), the UI says "contact this site's support" with the
request id or order id. Set your own contact in `SUPPORT_CONTACT`
(`src/lib/support.ts`, the only place it is defined). Do not send your users to
api@kotova.io: that is Kotova's support for you, the integrator. The proxy logs those
cases on the server (`[kx] ...`), with the request id or order id to quote when you
write to api@kotova.io.

## Project layout

```
openapi/openapi.v1.json         vendored API document (/x/v1)
scripts/api-types.mjs           pnpm gen:api / pnpm check:api
src/app/api/kx/[...path]/       server-side proxy (holds the key)
src/app/page.tsx                swap page
src/app/orders/[id]/page.tsx    order page
src/components/                 UI (plain CSS in src/app/globals.css)
src/lib/kx/server.ts            server settings: API base, key, end-user IP, session secret
src/lib/kx/order-cookie.ts      the signed cookie of orders created in this browser
src/lib/support.ts              SUPPORT_CONTACT: your support, shown to your users
src/lib/kx/                     API types, client, catalogue, errors, helpers
```

The look is deliberately plain: light only, system fonts, square corners and one
accent colour, all set as CSS variables at the top of `src/app/globals.css`.
Checkboxes are drawn in CSS, so they are square in every browser too.

## Language

The UI is English only. The app asks the API for English notices (`UI_LANG` in
`src/lib/kx/client.ts`). If you translate the UI, send your user's language instead
(`en`, `de`, `it`, `es`, `fr` or `ru`), so the source notices come back in it.

## End-user IP

Some sources check where the end user is and need `end_user_ip` on `POST /quote`;
without it the API skips them and the quote carries the warning
`end_user_ip_missing`. The proxy decides the IP on the server and never takes it from
the browser's request body. It trusts no header by default, because a visitor can send
any `X-Forwarded-For` value, and `next start` keeps a header the client sent.

| Setting | Use it when |
|---|---|
| `KOTOVA_END_USER_IP_HEADER=x-vercel-forwarded-for` | Hosted on Vercel. |
| `KOTOVA_END_USER_IP_HEADER=cf-connecting-ip` | Behind Cloudflare, with the origin reachable only through Cloudflare. |
| `KOTOVA_END_USER_IP_HEADER=fly-client-ip` | Hosted on Fly.io. |
| `KOTOVA_END_USER_IP_HEADER=x-real-ip` | Behind your own nginx with `proxy_set_header X-Real-IP $remote_addr;`. |
| `TRUSTED_PROXY_HOPS=N` | Behind N proxies that each append to `X-Forwarded-For` (nginx `$proxy_add_x_forwarded_for`, a cloud load balancer). The visitor is the N-th entry from the right; entries further left are chosen by the visitor. Only when the app cannot be reached without passing those proxies. |
| neither | No `end_user_ip` is sent. |

The header must hold one address and is tried first, then the hops; `X-Forwarded-For`
itself is refused as `KOTOVA_END_USER_IP_HEADER`. Check your host's documentation for
which header it sets and whether a client can send it too. Only a public unicast
address is sent, by the API's rules (`publicUnicastIp` in `src/lib/kx/server.ts`:
private, loopback, link-local, CGNAT, documentation, benchmarking and 6to4-relay ranges,
octets with a leading zero, and IPv6 outside `2000::/3` are refused; an IPv4-mapped or
6to4 address is judged by its IPv4 address). If the API still refuses the value, the
proxy asks for the quote once more without it.

**Testing from your machine.** Locally there is no public visitor IP, so sources that
need one are skipped. Set `KOTOVA_DEV_END_USER_IP` to your own public IP in
`.env.local` to try them. It is used only when `NODE_ENV` is not `production` (so
`pnpm dev`) and no trusted IP was found, and it must be a public address.

## Before you deploy

This is fine for local use as it is. Before you put it on the internet:

- **Rate-limit** `/api/kx/quote`, `/api/kx/addresses/validate`, `/api/kx/orders` and
  `/api/kx/orders/{id}` per visitor (at your host, a WAF or a middleware): every call
  spends your account's API budget, and an order read may refresh the order at its
  source.
- **Set `APP_SESSION_SECRET`** (32+ characters). Keep it stable: a new value makes the
  orders created before it unreadable in this app.
- **End-user IP**: choose `KOTOVA_END_USER_IP_HEADER` or `TRUSTED_PROXY_HOPS` for your
  host (see [End-user IP](#end-user-ip)). With neither, no IP is sent and the sources
  that need it are skipped.
- **Support contact**: set `SUPPORT_CONTACT` in `src/lib/support.ts` (see
  [Support contact](#support-contact)).
- **Function timeout**: the proxy route exports `maxDuration = 110` (seconds), because
  `POST /orders` may take the API up to 90 s when it tries fallback sources and the
  proxy waits up to 100 s for it. Your host (or plan) must allow a function to run
  that long; otherwise the request is cut off, and the app treats the answer as
  unknown and asks again with the same key.
- **https**: serve the app over https. In production the order cookie is `Secure`
  (see [Orders are private to the browser that created them](#orders-are-private-to-the-browser-that-created-them)).
- **Origin**: if a proxy in front of the app rewrites the `Host` header, set
  `APP_ORIGIN` to your site's origin; otherwise every POST is refused with
  `forbidden_origin`.
- Review the Content-Security-Policy in `next.config.js`, and add your own terms and
  privacy pages.

## Not included

- In-app choices for orders that need attention: the order page links to the hosted
  order page (`status_detail.resolve_url`, `order_url`).
- An account-wide order list: the app lists the orders created in this browser; the API
  lists all of them with `GET /orders`.
- Fiat values: the API has no prices.

## Roadmap

- **Next.js 15/16 and React 19.** The app is on Next.js 14.2 and React 18 for now. The
  planned upgrade moves to Next.js 15 or 16 with React 19, ESLint 9 with a flat config,
  and `eslint .` instead of `next lint` (removed in Next.js 16).

## License

[MIT](LICENSE). The license covers the code in this repository. It grants no rights to
the Kotova or Kotova X names or icons, or to any source's name or logo; the app loads
those from the API at runtime and shows them as the display requirements describe.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities through the
[Kotova bug bounty](https://docs.kotova.io/x/security/bug-bounty).
