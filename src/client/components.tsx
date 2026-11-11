import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, HelpCircle, LoaderCircle, ShieldAlert } from 'lucide-react';
import type { OrderState } from '../shared/domain';

const stateLabels: Record<OrderState, string> = {
  DRAFT: 'Draft',
  OFFERED: 'Ready to pay',
  AWAITING_PAYMENT: 'Awaiting payment',
  TRANSACTION_SEEN: 'Transaction submitted',
  FINALITY_PENDING: 'Finality pending',
  PAYMENT_OBSERVATION_UNKNOWN: 'Observation uncertain',
  PAID: 'Paid',
  FULFILMENT_PENDING: 'Fulfilment pending',
  FULFILMENT_DISPATCH_UNKNOWN: 'Fulfilment uncertain',
  FULFILLED: 'Fulfilled',
  REFUND_PENDING: 'Refund pending',
  REFUND_OBSERVATION_UNKNOWN: 'Refund uncertain',
  REFUNDED: 'Refunded',
  EXPIRED: 'Expired',
  CONFLICT: 'Needs review',
};

export function StatusBadge({ state }: { state: OrderState }) {
  const tone = ['FULFILLED', 'PAID', 'REFUNDED'].includes(state)
    ? 'success'
    : ['CONFLICT', 'EXPIRED'].includes(state)
      ? 'danger'
      : ['PAYMENT_OBSERVATION_UNKNOWN', 'FULFILMENT_DISPATCH_UNKNOWN', 'REFUND_OBSERVATION_UNKNOWN'].includes(state)
        ? 'warning'
        : 'pending';
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'danger' ? ShieldAlert : tone === 'warning' ? AlertTriangle : Clock3;
  return <span className={`status status--${tone}`}><Icon aria-hidden="true" size={15} />{stateLabels[state]}</span>;
}

export function Money({ luna }: { luna: number }) {
  const value = (luna / 100_000).toFixed(5).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  return <span className="money"><strong>{value}</strong> <span>NIM</span></span>;
}

export function ErrorPanel({ message, code }: { message: string; code?: string }) {
  return (
    <div className="notice notice--danger" role="alert" tabIndex={-1}>
      <AlertTriangle aria-hidden="true" />
      <div><strong>There is a problem</strong><p>{message}</p>{code ? <code>{code}</code> : null}</div>
    </div>
  );
}

export function Notice({ title, children, tone = 'info' }: { title: string; children: ReactNode; tone?: 'info' | 'warning' | 'success' }) {
  const Icon = tone === 'warning' ? AlertTriangle : tone === 'success' ? CheckCircle2 : HelpCircle;
  return <div className={`notice notice--${tone}`}><Icon aria-hidden="true" /><div><strong>{title}</strong><div>{children}</div></div></div>;
}

export function Loading({ label = 'Loading authoritative state' }: { label?: string }) {
  return <div className="loading" role="status"><LoaderCircle aria-hidden="true" className="spin" /><span>{label}</span></div>;
}

export function Field({ label, hint, error, children, htmlFor }: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  htmlFor: string;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <span className="field__hint" id={`${htmlFor}-hint`}>{hint}</span> : null}
      {error ? <span className="field__error" id={`${htmlFor}-error`} role="alert">{error}</span> : null}
    </div>
  );
}

export function ShortHash({ value }: { value: string }) {
  return <code title={value}>{value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value}</code>;
}
