# Verification evidence

Evidence recorded on 2026-11-11. Hosted deployment is verified below; a user-signed Nimiq Pay transaction remains a separate, unrun evidence class.

## Automated checks

| Command | Result | What it establishes |
| --- | --- | --- |
| `npm run typecheck` | PASS | Client, server, shared domain, and Vercel proxy compile under strict TypeScript. |
| `npm test` | PASS: 35; SKIP: 1 opt-in live test | Domain, reconciliation, exact-once, observer non-overlap, concurrency, staged-hash recovery, wallet uncertainty, terminal immutability, attempt promotion, queue isolation, idempotency, rate limits, Vercel wildcard proxy routing, and tamper controls. |
| `npm run build` | PASS | Server TypeScript and Vite production client build. |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities | No known production dependency vulnerability in the current npm advisory snapshot. |

## Live read-only contract check

```bash
RUN_LIVE_RPC=1 npx vitest run src/server/live-rpc.test.ts
```

Result: PASS. The current `https://rpc.nimiqwatch.com` response for a known mainnet transaction matched the validated transaction shape, reported Nimiq network ID 24, and produced a head-derived positive confirmation count. This proves read compatibility at the test time; it does not create an RPC availability guarantee.

## Production-build runtime check

The built server was started with a fresh temporary SQLite database and production static serving. The following were observed:

- The final Apple Silicon Docker build succeeded with a 396.3 kB allowlisted context; the image ran as user `node`.
- `GET /health` returned HTTP 200, database query success, and observer host `rpc.nimiqwatch.com`.
- `GET /api/meta` returned NIM mainnet, Mini App SDK 0.2.5, required confirmations, and the full-URL deep-link prefix.
- `/`, `/merchant`, and client deep routes returned the production `index.html` with security headers.
- A checksum-valid merchant recipient was persisted.
- A 0.00001 NIM order was sealed with a compact operation reference and checkout URL.
- A deliberately nonexistent public hash received a real read-only RPC lookup but remained attempt-level evidence; it did not claim the order or release fulfilment.
- Public attempts are excluded from the server background queue. Only a transaction that first matches exact sealed terms can become the canonical retried authority.
- The container handled SIGTERM and stopped cleanly.

## Regression coverage

- valid and invalid Nimiq checksum;
- exact decimal NIM conversion;
- sealed-term mutation detection;
- exact recipient/amount/network/execution/memo match;
- exact returned-transaction-hash binding;
- seconds-based sealed expiry enforcement;
- low-confirmation pending state;
- RPC unavailable and transaction-not-found uncertainty;
- exactly-once fulfilment across repeated reconciliation;
- one canonical payment operation under concurrent same-hash submissions;
- same hash with a new idempotency key;
- idempotency key with a changed hash;
- bogus mismatched and unknown attempts cannot block a later exact payment;
- more than 100 stale public attempts cannot starve canonical reconciliation or amplify background RPC calls;
- second hash after fulfilment cannot regress state;
- forged terms/columns cannot create a payment operation;
- swapped protected fulfilment cannot be released;
- mutable fulfilment-table copies cannot replace the integrity-sealed delivery, and a premature release fence is not exposed;
- a no-hash wallet outcome-unknown error disables payment until the user explicitly confirms checking wallet history;
- a wallet outcome-unknown error carrying a valid staged hash is persisted and sent to the observer automatically, while a no-hash outcome retains the manual-history fence;
- a slow scheduled observer pass cannot overlap the next interval, and concurrent reconciliation calls for one authority share one RPC observation;
- same-hash retries durably bind additional idempotency keys, and a changed payload is rejected;
- spoofed forwarded IP headers cannot bypass the per-checkout payment limit, whose 16th request returns HTTP 429;
- saved pre-expiry attempts remain visible and fenced after the displayed order expiry;
- unknown `/api/*` routes return JSON 404 instead of the SPA shell.

## Hosted deployment check

The exact Git commit `6d8985e80d1bf7bb4ef319e66cdc276e1df919a5` was deployed to `https://nimiq-orderseal.vercel.app` as Vercel deployment `dpl_F6St54GB4FsfzHJyhB7EMHP4aFFc`.

- Vercel reported the deployment `Ready` and listed only one function: `api/proxy`.
- `/` returned the production client with the configured security headers.
- `/api/meta` returned HTTP 200 with NIM mainnet, SDK 0.2.5, and 10 required confirmations.
- `/api/admin/orders` without a token returned backend JSON `401 ADMIN_AUTH_REQUIRED`, proving a nested API route reached the observer.
- `/api/public/orders/not-a-valid-token` returned backend JSON `404 ORDER_NOT_FOUND`, not a Vercel platform 404.
- The observer `/health` returned HTTP 200, a successful database query, and `rpc.nimiqwatch.com`.
- A 375 by 812 browser pass showed no horizontal overflow. Additional Nimiq Pay webview widths remain unverified.

The observer currently runs on the project owner's Mac through a Cloudflare Quick Tunnel with durable local SQLite. This is live and functional while the machine and tunnel remain online, but it is temporary and has no production uptime guarantee.

## Not yet run

- Migration to a production host with a mounted persistent volume, followed by backup/restore verification.
- Nimiq Pay host initialization on the deployed URL.
- User-approved mainnet NIM payment through the deployed Mini App.
- Browser visual checks at 768, 1024, and 1440 pixels and all checks in a real Nimiq Pay webview.
- Independent security audit and database restore drill.

These items must not be described as passed until evidence is captured.
