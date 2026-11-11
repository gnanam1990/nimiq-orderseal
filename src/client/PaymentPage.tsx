import { useCallback, useEffect, useMemo, useState } from 'react';
import { getHostNetwork, init, NimiqProviderError } from '@nimiq/mini-app-sdk';
import { ArrowUpRight, Check, Copy, ExternalLink, RefreshCw, Share2, ShieldCheck } from 'lucide-react';
import { api, ApiError, type MetaView } from './api';
import type { PublicOrderView } from '../shared/api';
import { ErrorPanel, Loading, Money, Notice, ShortHash, StatusBadge } from './components';

const immutableStates = new Set(['FULFILLED', 'REFUNDED', 'CONFLICT']);

function operationId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const values = new Uint8Array(16);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function PaymentPage({ token }: { token: string }) {
  const [order, setOrder] = useState<PublicOrderView | null>(null);
  const [meta, setMeta] = useState<MetaView | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [paying, setPaying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [attemptLocked, setAttemptLocked] = useState(() => Boolean(sessionStorage.getItem(`orderseal:payment:${token}`)));
  const [attemptState, setAttemptState] = useState<string | null>(null);
  const [hostNetwork] = useState(() => getHostNetwork());
  const inNimiqPay = hostNetwork !== undefined || Boolean(window.nimiqPay);

  const load = useCallback(async () => {
    try {
      const [nextOrder, nextMeta] = await Promise.all([api.publicOrder(token), api.meta()]);
      setOrder(nextOrder);
      setMeta(nextMeta);
      setError(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Could not load the order.';
      setError({ message, code: reason instanceof ApiError ? reason.code : undefined });
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (
      !order
      || immutableStates.has(order.state)
      || ((order.state === 'OFFERED' || order.state === 'EXPIRED') && !attemptLocked)
    ) return;
    const refresh = async () => {
      const saved = sessionStorage.getItem(`orderseal:payment:${token}`);
      if (attemptLocked && saved) {
        try {
          const parsed = JSON.parse(saved) as { txHash: string; idempotencyKey: string };
          if (/^[0-9a-f]{64}$/i.test(parsed.txHash)) {
            const next = await api.submitPayment(token, { ...parsed, hostNetwork: 'mainnet' });
            setOrder(next);
            setAttemptState(next.submittedAttempt?.state ?? 'OUTCOME_UNKNOWN');
            return;
          }
        } catch {
          // The general load below still refreshes authoritative order state.
        }
      }
      await load();
    };
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [attemptLocked, load, order, token]);

  useEffect(() => {
    const saved = sessionStorage.getItem(`orderseal:payment:${token}`);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as { txHash: string; idempotencyKey: string };
      if ('uncertainWithoutHash' in parsed && parsed.uncertainWithoutHash === true) {
        setAttemptLocked(true);
        setAttemptState('WALLET_OUTCOME_UNKNOWN');
        return;
      }
      if (/^[0-9a-f]{64}$/i.test(parsed.txHash)) {
        setAttemptLocked(true);
        void api.submitPayment(token, { ...parsed, hostNetwork: 'mainnet' }).then((next) => {
          setOrder(next);
          setAttemptState(next.submittedAttempt?.state ?? 'OUTCOME_UNKNOWN');
        }).catch(() => undefined);
      }
    } catch {
      sessionStorage.removeItem(`orderseal:payment:${token}`);
    }
  }, [token]);

  useEffect(() => {
    if (!order || (order.state !== 'FULFILLED' && order.state !== 'REFUNDED')) return;
    sessionStorage.removeItem(`orderseal:payment:${token}`);
    setAttemptLocked(false);
    setAttemptState(null);
  }, [order, token]);

  const expired = useMemo(() => order ? Date.now() >= Date.parse(order.expiresAt) : false, [order]);
  const canPay = order?.state === 'OFFERED' && !expired && hostNetwork === 'mainnet' && !attemptLocked;
  const checkoutUrl = useMemo(
    () => new URL(`/pay/${encodeURIComponent(token)}`, window.location.origin).toString(),
    [token],
  );
  const nimiqPayDeepLink = meta ? `${meta.nimiqPayDeepLinkPrefix}${encodeURIComponent(checkoutUrl)}` : '';

  const pay = async () => {
    if (!order || !canPay) return;
    setPaying(true);
    setError(null);
    try {
      const provider = await init();
      const txHash = await provider.sendBasicTransactionWithData({
        recipient: order.terms.recipient,
        value: order.terms.amountLuna,
        data: order.terms.memo,
      });
      const idempotencyKey = operationId();
      sessionStorage.setItem(`orderseal:payment:${token}`, JSON.stringify({ txHash, idempotencyKey }));
      setAttemptLocked(true);
      const next = await api.submitPayment(token, { txHash, idempotencyKey, hostNetwork: 'mainnet' });
      setOrder(next);
      setAttemptState(next.submittedAttempt?.state ?? 'OUTCOME_UNKNOWN');
    } catch (reason) {
      if (NimiqProviderError.is(reason)) {
        if (reason.type === 'PERMISSION_DENIED') {
          setError({ message: 'Payment was cancelled in Nimiq Pay. No success state was recorded.', code: reason.type });
        } else if (reason.type === 'NETWORK_ERROR' || reason.type === 'TRANSACTION_OUTCOME_UNKNOWN') {
          sessionStorage.setItem(`orderseal:payment:${token}`, JSON.stringify({
            uncertainWithoutHash: true,
            recordedAt: new Date().toISOString(),
          }));
          setAttemptLocked(true);
          setAttemptState('WALLET_OUTCOME_UNKNOWN');
          setError({ message: 'The wallet could not confirm whether submission occurred. Do not retry blindly—check wallet history first.', code: 'PAYMENT_SUBMISSION_UNKNOWN' });
        } else {
          setError({ message: reason.message, code: reason.type });
        }
      } else {
        setError({ message: reason instanceof Error ? reason.message : 'Payment could not be started.', code: 'PAYMENT_START_FAILED' });
      }
    } finally {
      setPaying(false);
    }
  };

  const clearLocalAttempt = () => {
    sessionStorage.removeItem(`orderseal:payment:${token}`);
    setAttemptLocked(false);
    setAttemptState(null);
    setError(null);
  };

  const copy = async () => {
    if (!order) return;
    await navigator.clipboard.writeText(order.terms.memo);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  const shareCheckout = async () => {
    if (navigator.share) {
      await navigator.share({ title: `OrderSeal ${order?.code ?? 'order'}`, url: checkoutUrl });
      return;
    }
    await navigator.clipboard.writeText(checkoutUrl);
    setLinkCopied(true);
    window.setTimeout(() => setLinkCopied(false), 1_500);
  };

  if (error && !order) return <div className="page-shell"><ErrorPanel {...error} /><button className="button button--secondary" onClick={() => void load()}>Try again</button></div>;
  if (!order || !meta) return <div className="page-shell"><Loading /></div>;

  return (
    <div className="page-shell checkout-shell">
      <section className="checkout-card" aria-labelledby="checkout-title">
        <div className="checkout-card__header">
          <div><span className="kicker">Integrity-sealed order · {order.code}</span><h1 id="checkout-title">{order.terms.itemName}</h1><p>{order.terms.description}</p></div>
          <StatusBadge state={order.state} />
        </div>

        <div className="amount-panel">
          <span>Amount due</span><Money luna={order.terms.amountLuna} />
          <small>NIM mainnet · wallet chooses sender · fees shown by Nimiq Pay</small>
        </div>

        <dl className="terms-grid">
          <div><dt>Recipient</dt><dd><ShortHash value={order.terms.recipient} /></dd></div>
          <div><dt>Expires</dt><dd>{new Date(order.terms.expiresAt).toLocaleString()}</dd></div>
          <div><dt>Operation reference</dt><dd><button className="copy-value" onClick={() => void copy()}>{order.terms.memo}{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button></dd></div>
          <div><dt>OrderSeal integrity tag</dt><dd><ShortHash value={order.signature} /></dd></div>
        </dl>

        {error ? <ErrorPanel {...error} /> : null}

        {attemptLocked && (order.state === 'OFFERED' || order.state === 'EXPIRED') ? (
          <Notice title={attemptState === 'REJECTED' ? 'Submitted transaction did not match' : attemptState === 'WALLET_OUTCOME_UNKNOWN' ? 'Wallet outcome is unknown' : 'Transaction observation is pending'} tone="warning">
            <p>
              {attemptState === 'REJECTED'
                ? 'This hash was not promoted to payment authority. Check wallet history before starting another payment.'
                : attemptState === 'WALLET_OUTCOME_UNKNOWN'
                  ? 'The wallet returned no transaction hash. OrderSeal cannot observe it automatically. Check wallet history before choosing to retry.'
                : 'OrderSeal has not promoted this hash to the canonical payment yet. Do not retry blindly while the observer is uncertain.'}
            </p>
            {attemptState === 'REJECTED' || attemptState === 'WALLET_OUTCOME_UNKNOWN' ? (
              <button className="inline-link inline-link--button" type="button" onClick={clearLocalAttempt}>I checked wallet history — allow retry</button>
            ) : null}
          </Notice>
        ) : null}

        {!inNimiqPay ? (
          <Notice title="Open this order inside Nimiq Pay" tone="warning">
            <p>This browser has no injected wallet provider. OrderSeal will not simulate a payment.</p>
            <div className="handoff-actions">
              <a className="inline-link" href={nimiqPayDeepLink}>Open this order in Nimiq Pay <ExternalLink aria-hidden="true" size={16} /></a>
              <button className="inline-link inline-link--button" type="button" onClick={() => void shareCheckout()}>
                {linkCopied ? 'Checkout link copied' : 'Share checkout link'}
                {linkCopied ? <Check aria-hidden="true" size={16} /> : <Share2 aria-hidden="true" size={16} />}
              </button>
            </div>
          </Notice>
        ) : hostNetwork !== 'mainnet' ? (
          <Notice title="Switch Nimiq Pay to mainnet" tone="warning"><p>Competition orders cannot be paid on testnet. Current host network: {hostNetwork ?? 'unknown'}.</p></Notice>
        ) : null}

        {order.state === 'FULFILLED' && order.fulfilment ? (
          <div className="fulfilment" role="status">
            <ShieldCheck aria-hidden="true" />
            <div><span>Settlement verified · fulfilment released</span><h2>{order.fulfilment.reference}</h2><p>{order.fulfilment.message}</p><small>Released {new Date(order.fulfilment.releasedAt).toLocaleString()}</small></div>
          </div>
        ) : (
          <button className="button button--primary button--wide" disabled={!canPay || paying} onClick={() => void pay()}>
            {paying ? 'Waiting for wallet approval…' : attemptLocked ? 'Payment observation pending' : expired ? 'Order expired' : order.state === 'OFFERED' ? 'Review and pay in Nimiq Pay' : 'Payment is being verified'}
            {!paying ? <ArrowUpRight aria-hidden="true" /> : null}
          </button>
        )}

        <div className="finality-panel" aria-live="polite">
          <div><span>Configured RPC observer</span><strong>{order.observer.source}</strong></div>
          <div><span>Confirmations</span><strong>{order.paymentConfirmations ?? 0} / {order.observer.requiredConfirmations}</strong></div>
          <div><span>Freshness</span><strong>{order.observer.freshness.replace('_', ' ')}</strong></div>
          <button className="icon-button" aria-label="Refresh authoritative order state" onClick={() => void load()}><RefreshCw aria-hidden="true" /></button>
        </div>

        {order.conflictReasons.length > 0 ? <Notice title="Payment needs merchant review" tone="warning"><ul>{order.conflictReasons.map((reason) => <li key={reason}>{reason.replaceAll('_', ' ')}</li>)}</ul></Notice> : null}
      </section>
      <aside className="evidence-card">
        <span className="kicker">What OrderSeal checks</span>
        <ol><li>Execution result is successful</li><li>Network ID is Nimiq mainnet</li><li>Recipient matches sealed terms</li><li>Amount matches in Luna</li><li>Public operation reference matches</li><li>Finality threshold is reached</li></ol>
        {order.paymentTxHash ? <p>Transaction <ShortHash value={order.paymentTxHash} /></p> : <p>No transaction has been submitted.</p>}
        <small>Refund execution is unsupported. Merchant-approved refunds can only be observed after a separate wallet transaction.</small>
      </aside>
    </div>
  );
}
