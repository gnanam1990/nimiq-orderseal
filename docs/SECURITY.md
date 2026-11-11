# Security model

## Assets and trust

- Nimiq Pay retains private keys and displays the wallet confirmation. OrderSeal never receives a seed phrase or signing key.
- The merchant operator token protects configuration, order creation, order listing, and manual reconciliation.
- The signing secret authenticates canonical order terms and the protected fulfilment digest.
- A public checkout token is a bearer capability. Anyone holding it can view the order and, after settlement, its released fulfilment message.
- The JSON-RPC provider is trusted for chain reads. The client transaction hash is never trusted as settlement proof.

## Implemented controls

- Constant-time comparison for the operator bearer token.
- Minimum token/secret lengths enforced at process startup.
- Fastify request limits, rate limits, security headers, and sensitive-log redaction.
- Forwarded IP headers are not trusted. Public/payment rate-limit buckets use a SHA-256 digest of the checkout capability, so XFF spoofing and shared Vercel egress do not collapse or bypass checkout limits.
- CSP and `Referrer-Policy: no-referrer` on the persistent server; equivalent headers are configured for Vercel.
- Checksum validation and normalization for merchant Nimiq addresses.
- Integer-only Luna values and strict decimal conversion.
- HMAC verification plus row-to-terms consistency and fulfilment-message digest verification on every release path.
- Server-side transaction hash, execution, network, recipient, value, memo, expiry, and finality checks through the configured trusted RPC.
- Unique database fences and transactional version-CAS updates.
- Durable idempotency aliases keep every accepted operation key bound to the same transaction hash.
- Terminal-state guards after asynchronous chain reads.
- Wallet `NETWORK_ERROR` and `TRANSACTION_OUTCOME_UNKNOWN` results create a local no-retry fence even when no hash is returned.
- The integrity-sealed order row is the only fulfilment payload source; the fulfilment table is only the release authorization fence and is never exposed before `FULFILLED`.
- No hard-coded success response on the payment or fulfilment path.

## Operational requirements

- Generate independent high-entropy operator and signing secrets. Never reuse wallet credentials.
- Store secrets in Railway environment variables, not Vercel client variables or source control.
- Mount and back up a Railway volume at `/data`; test restore procedures.
- Restrict operator-token distribution and rotate it after suspected exposure.
- Replace or augment the public demonstration RPC for production availability and provider diversity.
- Review access logs and `order_integrity_failure`, `payment_submission_rejected`, and `payment_conflict` audit events.
- Use HTTPS-only origins. The Vercel proxy rejects non-HTTPS backend configuration.

## Known boundaries

- HMAC terms are deployment-authenticated, not a portable public-key merchant signature.
- The checkout URL is a bearer secret and may exist in browser history or user-shared messages. The application suppresses outbound referrers but cannot control a user's sharing destination.
- A merchant can bypass OrderSeal by delivering outside the product. The enforcement claim is limited to the built-in release path.
- The refund endpoint intentionally returns `501 REFUND_EXECUTION_UNSUPPORTED`; there is no server wallet.
- SQLite with one Railway instance is appropriate for this release. Horizontal writers require a transactional external database and equivalent constraints.
- No independent security audit has been completed.

## Reporting

Do not include private keys, production secrets, wallet seed phrases, or live checkout tokens in a report. Open a private security advisory on the repository once remote security reporting is configured.
