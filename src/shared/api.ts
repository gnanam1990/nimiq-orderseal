import type { OrderState, SignedOrderTerms } from './domain.js';

export interface MerchantConfigView {
  recipient: string;
  network: 'mainnet';
  revision: number;
  verifiedAt: string;
}

export interface OrderSummary {
  id: string;
  code: string;
  publicToken: string;
  state: OrderState;
  itemName: string;
  amountLuna: number;
  recipient: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  paymentTxHash: string | null;
  paymentConfirmations: number | null;
  conflictReasons: string[];
  refundExecution: 'OBSERVATION_ONLY';
}

export interface PublicOrderView extends OrderSummary {
  terms: SignedOrderTerms;
  signature: string;
  observer: {
    source: string;
    lastCheckedAt: string | null;
    requiredConfirmations: number;
    freshness: 'fresh' | 'stale' | 'not_checked';
  };
  fulfilment: null | {
    reference: string;
    message: string;
    releasedAt: string;
  };
  refund: {
    execution: 'UNSUPPORTED';
    mode: 'OBSERVATION_ONLY';
    finalizedLuna: number;
  };
  submittedAttempt?: {
    txHash: string;
    state: string;
    reasons: string[];
  };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
  };
}
