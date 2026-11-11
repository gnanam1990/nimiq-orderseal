# Deployment runbook

The intended production topology is a Vercel client and same-origin API proxy backed by one persistent Railway Fastify service. Do not run the SQLite observer inside a Vercel function.

## 1. Railway backend

1. Create a Railway service from this repository. The included `railway.toml` selects the multi-stage `Dockerfile`.
2. Add a persistent volume mounted at `/data`.
3. Set the following variables:

```text
NODE_ENV=production
ORDERSEAL_DB_PATH=/data/orderseal.db
ORDERSEAL_ADMIN_TOKEN=<at least 24 random characters>
ORDERSEAL_SIGNING_SECRET=<at least 32 random characters>
NIMIQ_RPC_URL=https://rpc.nimiqwatch.com
NIMIQ_REQUIRED_CONFIRMATIONS=10
ORDERSEAL_PUBLIC_ORIGIN=https://<final-vercel-domain>
ORDERSEAL_OBSERVER_INTERVAL_MS=7000
```

Railway supplies `PORT`; do not hard-code it. Deploy, create a public HTTPS domain, and verify `GET /health` returns `status: ok`. At this point the backend can also serve the built client, but the public competition URL should use the Vercel topology below.

## 2. Vercel client and proxy

1. Import the same repository in Vercel.
2. Keep the included build configuration: `npm run build:client`, output `dist/client`.
3. Set `ORDERSEAL_API_ORIGIN` to the Railway HTTPS origin, with no path, credentials, or query string.
4. Deploy and verify `/`, `/merchant`, and `/api/meta`.
5. Update Railway `ORDERSEAL_PUBLIC_ORIGIN` to the final Vercel origin and redeploy Railway. New checkout URLs will now use the public client domain.

The Vercel function forwards only `/api/*`, caps request bodies, forwards the required content/auth headers, disables response caching, and times out without recording a success state.

## 3. Nimiq Pay verification

1. Create a small capped mainnet order from `/merchant` using the merchant's own recipient.
2. Open the exact `/pay/<publicToken>` URL in Nimiq Pay. From a normal browser, use **Open this order in Nimiq Pay**; the custom scheme carries the complete encoded checkout URL so the token/path is preserved.
3. Verify Nimiq Pay reports `mainnet` before enabling payment.
4. Review the recipient, NIM amount, and fee in the wallet. The user must approve the transaction; deployment does not authorize signing.
5. After broadcast, observe `FINALITY_PENDING`, the confirmation count, and then `FULFILLED` only after the threshold.
6. Capture the transaction explorer/RPC evidence and the released fulfilment in the same demo.

## 4. Failure checks before release

- Submit a nonexistent hash in a non-production order and confirm it remains attempt-level unknown: it must not claim the order or enter the background queue.
- After an exact low-confirmation payment has been promoted to authority, stop the observer and confirm the canonical order becomes `PAYMENT_OBSERVATION_UNKNOWN`, not unpaid or fulfilled.
- Submit the same hash with a new idempotency key and confirm no second operation exists.
- Submit a mismatched/unknown hash first, then an exact valid hash; confirm the valid payment can still fulfil. Attempt another hash after fulfilment and confirm the order remains fulfilled.
- Restore a database backup in an isolated service and verify order/operation/audit counts.
- Confirm the Railway volume survives a service restart.

## Rollback

Roll back application code without deleting `/data`. If a migration or integrity check fails, stop the service, preserve the database and WAL files, and investigate from a copy. Never replace the evidence database with a blank file to make a deployment healthy.
