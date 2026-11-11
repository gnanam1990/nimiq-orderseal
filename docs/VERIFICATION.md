# Verification evidence

Evidence recorded on 2026-11-11 in the local repository. Hosted deployment and a user-signed Nimiq Pay transaction remain separate, unrun evidence classes.

## Automated checks

| Command | Result | What it establishes |
| --- | --- | --- |
| `npm run typecheck` | PASS | Client, server, shared domain, and Vercel proxy compile under strict TypeScript. |
| `npm test` | PASS: 25; SKIP: 1 opt-in live test | Domain, reconciliation, exact-once, concurrency, wallet uncertainty, terminal immutability, attempt promotion, queue isolation, idempotency, rate limits, routing, and tamper controls. |
| `npm run build` | PASS | Server TypeScript and Vite production client build. |
| `npm audit --omit=dev` | PASS: 0 vulnerabilities | No known production dependency vulnerability in the current npm advisory snapshot. |

## Live read-only contract check

```bash
RUN_LIVE_RPC=1 npx vitest run src/server/live-rpc.test.ts
```

Result: PASS. The current `https://rpc.nimiqwatch.com` response for a known mainnet transaction matched the validated transaction shape, reported Nimiq network ID 24, and produced a head-derived positive confirmation count. This proves read compatibility at the test time; it does not create an RPC availability guarantee.

## Production-build runtime check

The built server was started with a fresh temporary SQLite database and production static serving. The following were observed:

- The final Apple Silicon Docker build succeeded with a 376.8 kB allowlisted context; the image ran as user `node`.
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
- a wallet outcome-unknown error disables payment until the user explicitly confirms checking wallet history;
- same-hash retries durably bind additional idempotency keys, and a changed payload is rejected;
- spoofed forwarded IP headers cannot bypass the per-checkout payment limit, whose 16th request returns HTTP 429;
- saved pre-expiry attempts remain visible and fenced after the displayed order expiry;
- unknown `/api/*` routes return JSON 404 instead of the SPA shell.

## Not yet run

- Railway deployment with a mounted persistent volume.
- Vercel deployment and deployed proxy check.
- Nimiq Pay host initialization on the deployed URL.
- User-approved mainnet NIM payment through the deployed Mini App.
- Browser visual checks at 375, 768, 1024, and 1440 pixels in a real Nimiq Pay webview.
- Independent security audit and database restore drill.

These items must not be described as passed until evidence is captured.
