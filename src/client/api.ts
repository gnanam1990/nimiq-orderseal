import type { MerchantConfigView, OrderSummary, PublicOrderView } from '../shared/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

async function parse<T>(response: Response): Promise<T> {
  const body = await response.json() as T | { error?: { code?: string; message?: string; fields?: Record<string, string> } };
  if (!response.ok) {
    const error = 'error' in (body as object) ? (body as { error?: { code?: string; message?: string; fields?: Record<string, string> } }).error : undefined;
    throw new ApiError(
      error?.message ?? `Request failed with HTTP ${response.status}`,
      error?.code ?? 'REQUEST_FAILED',
      response.status,
      error?.fields,
    );
  }
  return body as T;
}

export interface MetaView {
  name: string;
  asset: 'NIM';
  network: 'mainnet';
  miniAppSdk: string;
  requiredConfirmations: number;
  refundExecution: 'UNSUPPORTED';
  refundMode: 'OBSERVATION_ONLY';
  nimiqPayDeepLinkPrefix: 'nimiqpay://miniapp?url=';
}

export const api = {
  meta: () => fetch('/api/meta').then(parse<MetaView>),
  publicOrder: (token: string) => fetch(`/api/public/orders/${encodeURIComponent(token)}`).then(parse<PublicOrderView>),
  submitPayment: (token: string, input: { txHash: string; hostNetwork: 'mainnet'; idempotencyKey: string }) =>
    fetch(`/api/public/orders/${encodeURIComponent(token)}/payment-attempt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then(parse<PublicOrderView>),
  merchantConfig: (token: string) =>
    fetch('/api/admin/merchant-config', { headers: auth(token) }).then(parse<MerchantConfigView>),
  saveMerchantConfig: (token: string, recipient: string) =>
    fetch('/api/admin/merchant-config', {
      method: 'POST',
      headers: { ...auth(token), 'content-type': 'application/json' },
      body: JSON.stringify({ recipient }),
    }).then(parse<MerchantConfigView>),
  orders: (token: string) =>
    fetch('/api/admin/orders', { headers: auth(token) }).then(parse<{ orders: OrderSummary[] }>),
  createOrder: (token: string, input: {
    itemName: string;
    description: string;
    amountNim: string;
    expiresInMinutes: number;
    fulfilmentReference: string;
    fulfilmentMessage: string;
  }) => fetch('/api/admin/orders', {
    method: 'POST',
    headers: { ...auth(token), 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }).then(parse<OrderSummary & { checkoutUrl: string; signature: string; memo: string }>),
  reconcile: (token: string, orderId: string) =>
    fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/reconcile`, {
      method: 'POST',
      headers: auth(token),
    }).then(parse<{ order: PublicOrderView }>),
};

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
