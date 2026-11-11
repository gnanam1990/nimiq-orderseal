# Submission notes

## Short description

OrderSeal is a Nimiq Pay Mini App that prevents a merchant from treating a wallet callback or transaction hash as a paid order. A merchant creates a sealed NIM order containing the exact mainnet recipient, Luna amount, expiry, and compact operation reference. The customer approves the native transaction in Nimiq Pay. A persistent backend then reads Nimiq mainnet through one configured RPC, validates the hash, execution result, network, recipient, value, memo, transaction time, and confirmation policy, and releases the protected fulfilment exactly once. Unknown RPC outcomes remain visibly fenced instead of being converted into a false failure or blind retry. The product includes a merchant console, public checkout, durable evidence ledger, conflict handling, and a responsive finality view.

## Demonstration sequence

1. Open the landing page headline: **A transaction hash is not a paid order.**
2. In **Merchant console**, show the mainnet recipient and create a small real order.
3. Open the generated checkout and show the sealed recipient, amount, operation reference, and OrderSeal integrity tag.
4. In Nimiq Pay, review and approve the real mainnet transaction. Do not edit or simulate the wallet result.
5. Show **Payment is being verified** and the configured RPC confirmation counter.
6. Show **Settlement verified · fulfilment released** only after the configured threshold.
7. Show one failure path using a separate safe order: an unavailable/not-found observation remains **Payment observation unknown** and releases nothing.
8. End with repository architecture, automated checks, and explicit refund limitation.

## Claims gate

Do not claim hosted, Nimiq-Pay-tested, mainnet-paid, or submitted until each has direct evidence. A locally passing live RPC read is not a wallet payment. A Vercel client without a reachable persistent observer and durable database is not a working deployment.
