import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, KeyRound, Plus, RefreshCw, Settings2, ShieldAlert } from 'lucide-react';
import type { MerchantConfigView, OrderSummary } from '../shared/api';
import { api, ApiError } from './api';
import { ErrorPanel, Field, Loading, Money, Notice, ShortHash, StatusBadge } from './components';

export function MerchantPage() {
  const [token, setToken] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [config, setConfig] = useState<MerchantConfigView | null>(null);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);

  const load = useCallback(async (candidate = token) => {
    setLoading(true);
    setError(null);
    try {
      const [configResult, orderResult] = await Promise.allSettled([
        api.merchantConfig(candidate), api.orders(candidate),
      ]);
      if (orderResult.status === 'rejected') throw orderResult.reason;
      setOrders(orderResult.value.orders);
      setConfig(configResult.status === 'fulfilled' ? configResult.value : null);
      setAuthenticated(true);
    } catch (reason) {
      setAuthenticated(false);
      setError({ message: reason instanceof Error ? reason.message : 'Could not open the console.', code: reason instanceof ApiError ? reason.code : undefined });
    } finally {
      setLoading(false);
    }
  }, [token]);

  if (!authenticated) {
    return <OperatorLogin token={token} setToken={setToken} loading={loading} error={error} onSubmit={() => void load(token)} />;
  }

  return (
    <div className="console-shell">
      <aside className="console-sidebar">
        <span className="kicker">Merchant operations</span><h1>Settlement desk</h1>
        <p>Authoritative order state, conflicts and recoveries. Operator token remains only in this tab's memory.</p>
        <nav aria-label="Console sections"><a href="#orders">Orders</a><a href="#create">Create order</a><a href="#configuration">Receiving setup</a></nav>
        <button className="button button--secondary button--wide" onClick={() => void load()}><RefreshCw aria-hidden="true" />Refresh queues</button>
      </aside>
      <div className="console-main">
        <section className="console-topline"><div><span className="kicker">Mainnet control plane</span><h2>Orders and evidence</h2></div><div className="health-chip"><span />Backend connected</div></section>
        {error ? <ErrorPanel {...error} /> : null}
        {!config ? <ConfigForm token={token} onSaved={(next) => { setConfig(next); void load(); }} /> : null}
        {config ? <CreateOrderForm token={token} config={config} onCreated={() => void load()} /> : null}
        <OrderQueue token={token} orders={orders} onChange={() => void load()} />
        {config ? <ConfigSummary config={config} token={token} onSaved={(next) => { setConfig(next); void load(); }} /> : null}
      </div>
    </div>
  );
}

function OperatorLogin({ token, setToken, loading, error, onSubmit }: {
  token: string;
  setToken: (value: string) => void;
  loading: boolean;
  error: { message: string; code?: string } | null;
  onSubmit: () => void;
}) {
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit(); };
  return <div className="page-shell login-shell"><section className="login-card"><div className="login-card__icon"><KeyRound aria-hidden="true" /></div><span className="kicker">Restricted merchant surface</span><h1>Open the settlement desk</h1><p>The operator token is checked by the server and kept only in this tab's React memory. It is never written to local or session storage.</p>{error ? <ErrorPanel {...error} /> : null}<form onSubmit={submit}><Field label="Operator token" htmlFor="operator-token" hint="Use the ORDERSEAL_ADMIN_TOKEN configured on the deployment."><input id="operator-token" type="password" autoComplete="off" minLength={24} value={token} onChange={(event) => setToken(event.target.value)} aria-describedby="operator-token-hint" required /></Field><button className="button button--primary button--wide" disabled={loading || token.length < 24}>{loading ? 'Checking…' : 'Open console'}</button></form></section></div>;
}

function ConfigForm({ token, onSaved }: { token: string; onSaved: (config: MerchantConfigView) => void }) {
  const [recipient, setRecipient] = useState('');
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [saving, setSaving] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null);
    try { onSaved(await api.saveMerchantConfig(token, recipient)); }
    catch (reason) { setError({ message: reason instanceof Error ? reason.message : 'Could not save configuration.', fields: reason instanceof ApiError ? reason.fields : {} }); window.setTimeout(() => errorRef.current?.focus(), 0); }
    finally { setSaving(false); }
  };
  const recipientDescription = ['recipient-hint', error?.fields?.recipient ? 'recipient-error' : null].filter(Boolean).join(' ');
  return <section className="panel" id="configuration"><div className="panel__heading"><div><span className="kicker">Required first</span><h2>Configure receiving address</h2></div><Settings2 aria-hidden="true" /></div><p>Every new order snapshots this address into server-authenticated immutable terms. Changing it creates a new configuration revision and never rewrites old orders.</p>{error ? <div ref={errorRef} tabIndex={-1}><ErrorPanel message={error.message} /></div> : null}<form onSubmit={(event) => void submit(event)} className="form-grid"><Field label="Nimiq mainnet address" htmlFor="recipient" hint="OrderSeal validates the NQ address checksum before accepting it." error={error?.fields?.recipient}><input id="recipient" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="NQ…" aria-describedby={recipientDescription} aria-invalid={Boolean(error?.fields?.recipient)} required /></Field><button className="button button--primary" disabled={saving}>{saving ? 'Saving…' : 'Save receiving setup'}</button></form></section>;
}

function CreateOrderForm({ token, config, onCreated }: { token: string; config: MerchantConfigView; onCreated: () => void }) {
  const [form, setForm] = useState({ itemName: '', description: '', amountNim: '', expiresInMinutes: 60, fulfilmentReference: '', fulfilmentMessage: '' });
  const [error, setError] = useState<{ message: string; code?: string; fields?: Record<string, string> } | null>(null);
  const [created, setCreated] = useState<{ checkoutUrl: string; memo: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null); setCreated(null);
    try {
      const result = await api.createOrder(token, form); setCreated(result); setForm({ ...form, itemName: '', description: '', amountNim: '', fulfilmentReference: '', fulfilmentMessage: '' }); onCreated();
    } catch (reason) { setError({ message: reason instanceof Error ? reason.message : 'Could not create order.', code: reason instanceof ApiError ? reason.code : undefined, fields: reason instanceof ApiError ? reason.fields : {} }); window.setTimeout(() => errorRef.current?.focus(), 0); }
    finally { setSaving(false); }
  };
  const update = (key: keyof typeof form, value: string | number) => setForm((current) => ({ ...current, [key]: value }));
  return <section className="panel" id="create"><div className="panel__heading"><div><span className="kicker">Server-authenticated offer</span><h2>Create an order</h2></div><Plus aria-hidden="true" /></div><p>Receiving address <ShortHash value={config.recipient} /> · configuration revision {config.revision}.</p>{error ? <div ref={errorRef} tabIndex={-1}><ErrorPanel message={error.message} code={error.code} /></div> : null}{created ? <Notice title="Order sealed" tone="success"><p>The checkout link points to this integrity-sealed revision. Share it with the customer.</p><button className="copy-value" onClick={() => void navigator.clipboard.writeText(created.checkoutUrl).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>{created.checkoutUrl}{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button><p>On-chain memo: <code>{created.memo}</code></p></Notice> : null}<form className="form-grid form-grid--two" onSubmit={(event) => void submit(event)}><Field label="Item or service" htmlFor="item-name" error={error?.fields?.itemName}><input id="item-name" value={form.itemName} onChange={(event) => update('itemName', event.target.value)} aria-describedby={error?.fields?.itemName ? 'item-name-error' : undefined} aria-invalid={Boolean(error?.fields?.itemName)} required maxLength={120} /></Field><Field label="Amount in NIM" htmlFor="amount" hint="Up to 5 decimal places." error={error?.fields?.amountNim}><input id="amount" inputMode="decimal" value={form.amountNim} onChange={(event) => update('amountNim', event.target.value)} placeholder="0.01" aria-describedby={['amount-hint', error?.fields?.amountNim ? 'amount-error' : null].filter(Boolean).join(' ')} aria-invalid={Boolean(error?.fields?.amountNim)} required /></Field><Field label="Description" htmlFor="description" error={error?.fields?.description}><textarea id="description" value={form.description} onChange={(event) => update('description', event.target.value)} aria-describedby={error?.fields?.description ? 'description-error' : undefined} aria-invalid={Boolean(error?.fields?.description)} required maxLength={500} /></Field><Field label="Expires in minutes" htmlFor="expiry" error={error?.fields?.expiresInMinutes}><input id="expiry" type="number" min={5} max={10080} value={form.expiresInMinutes} onChange={(event) => update('expiresInMinutes', Number(event.target.value))} aria-describedby={error?.fields?.expiresInMinutes ? 'expiry-error' : undefined} aria-invalid={Boolean(error?.fields?.expiresInMinutes)} required /></Field><Field label="Fulfilment reference" htmlFor="fulfilment-reference" hint="A human-readable delivery label shown after finality." error={error?.fields?.fulfilmentReference}><input id="fulfilment-reference" value={form.fulfilmentReference} onChange={(event) => update('fulfilmentReference', event.target.value)} aria-describedby={['fulfilment-reference-hint', error?.fields?.fulfilmentReference ? 'fulfilment-reference-error' : null].filter(Boolean).join(' ')} aria-invalid={Boolean(error?.fields?.fulfilmentReference)} required maxLength={120} /></Field><Field label="Protected fulfilment message" htmlFor="fulfilment-message" hint="Released only after exact payment verification." error={error?.fields?.fulfilmentMessage}><textarea id="fulfilment-message" value={form.fulfilmentMessage} onChange={(event) => update('fulfilmentMessage', event.target.value)} aria-describedby={['fulfilment-message-hint', error?.fields?.fulfilmentMessage ? 'fulfilment-message-error' : null].filter(Boolean).join(' ')} aria-invalid={Boolean(error?.fields?.fulfilmentMessage)} required maxLength={1500} /></Field><button className="button button--primary" disabled={saving}>{saving ? 'Sealing order…' : 'Create sealed order'}<Plus aria-hidden="true" /></button></form></section>;
}

function OrderQueue({ token, orders, onChange }: { token: string; orders: OrderSummary[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const reconcile = async (order: OrderSummary) => { setBusy(order.id); setError(null); try { await api.reconcile(token, order.id); onChange(); } catch (reason) { setError({ message: reason instanceof Error ? reason.message : 'Reconciliation failed.', code: reason instanceof ApiError ? reason.code : undefined }); } finally { setBusy(null); } };
  return <section className="panel" id="orders"><div className="panel__heading"><div><span className="kicker">Durable queue</span><h2>Orders</h2></div><span className="count-chip">{orders.length}</span></div>{error ? <ErrorPanel {...error} /> : null}{orders.length === 0 ? <div className="empty-state"><ShieldAlert aria-hidden="true" /><h3>No orders yet</h3><p>Create the first integrity-sealed order. No seeded success records are shown.</p></div> : <div className="order-list">{orders.map((order) => <article className="order-row" key={order.id}><div className="order-row__identity"><span>{order.code}</span><h3>{order.itemName}</h3><small>Created {new Date(order.createdAt).toLocaleString()}</small></div><Money luna={order.amountLuna} /><StatusBadge state={order.state} /><div className="order-row__evidence">{order.paymentTxHash ? <ShortHash value={order.paymentTxHash} /> : <span>No canonical transaction</span>}<small>{order.paymentConfirmations ?? 0} confirmations</small></div><div className="order-row__actions"><a className="icon-button" aria-label={`Open checkout for ${order.code}`} href={`/pay/${order.publicToken}`} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" /></a>{order.paymentTxHash && !['FULFILLED', 'REFUNDED', 'CONFLICT'].includes(order.state) ? <button className="icon-button" aria-label={`Reconcile ${order.code}`} disabled={busy === order.id} onClick={() => void reconcile(order)}><RefreshCw aria-hidden="true" className={busy === order.id ? 'spin' : ''} /></button> : null}</div></article>)}</div>}</section>;
}

function ConfigSummary({ config, token, onSaved }: { config: MerchantConfigView; token: string; onSaved: (config: MerchantConfigView) => void }) {
  const [editing, setEditing] = useState(false);
  return <section className="panel" id="configuration"><div className="panel__heading"><div><span className="kicker">Receiving setup · revision {config.revision}</span><h2>Merchant configuration</h2></div><Settings2 aria-hidden="true" /></div><dl className="terms-grid"><div><dt>Recipient</dt><dd>{config.recipient}</dd></div><div><dt>Network</dt><dd>Mainnet</dd></div><div><dt>Recorded</dt><dd>{new Date(config.verifiedAt).toLocaleString()}</dd></div><div><dt>Refund authority</dt><dd>Observation only</dd></div></dl><button className="button button--secondary" onClick={() => setEditing(!editing)}>{editing ? 'Cancel change' : 'Create new configuration revision'}</button>{editing ? <ConfigForm token={token} onSaved={(next) => { setEditing(false); onSaved(next); }} /> : null}</section>;
}
