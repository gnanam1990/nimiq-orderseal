import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const ORDER_STATES = [
  'DRAFT',
  'OFFERED',
  'AWAITING_PAYMENT',
  'TRANSACTION_SEEN',
  'FINALITY_PENDING',
  'PAYMENT_OBSERVATION_UNKNOWN',
  'PAID',
  'FULFILMENT_PENDING',
  'FULFILMENT_DISPATCH_UNKNOWN',
  'FULFILLED',
  'REFUND_PENDING',
  'REFUND_OBSERVATION_UNKNOWN',
  'REFUNDED',
  'EXPIRED',
  'CONFLICT',
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export type Network = 'mainnet';

export interface SignedOrderTerms {
  id: string;
  code: string;
  revision: number;
  itemName: string;
  description: string;
  recipient: string;
  amountLuna: number;
  asset: 'NIM';
  network: Network;
  expiresAt: string;
  fulfilmentReference: string;
  fulfilmentDigest: string;
  termsRevision: number;
  memo: string;
}

export interface ObservedTransaction {
  hash: string;
  blockNumber: number;
  timestamp: number;
  confirmations: number;
  from: string;
  to: string;
  value: number;
  recipientData: string;
  networkId: number;
  executionResult: boolean;
}

export interface PaymentMatch {
  ok: boolean;
  reasons: string[];
  decodedMemo: string;
}

export function normalizeNimiqAddress(value: string): string {
  const compact = value.toUpperCase().replace(/\s+/g, '');
  return compact.replace(/(.{4})(?=.)/g, '$1 ').trim();
}

function ibanMod97(value: string): number {
  let remainder = 0;
  for (const character of value) {
    const digits = /[A-Z]/.test(character)
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

export function isValidNimiqAddress(value: string): boolean {
  const compact = value.toUpperCase().replace(/\s+/g, '');
  if (!/^NQ\d{2}[0-9A-HJ-NP-VXY]{32}$/.test(compact)) return false;
  return ibanMod97(`${compact.slice(4)}${compact.slice(0, 4)}`) === 1;
}

export function parseNimToLuna(value: string): number {
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,5})?$/.test(value)) {
    throw new Error('Enter a NIM amount with at most 5 decimal places.');
  }
  const [whole, fraction = ''] = value.split('.');
  const luna = Number(whole) * 100_000 + Number(fraction.padEnd(5, '0'));
  if (!Number.isSafeInteger(luna) || luna < 1 || luna > 100_000_000_000) {
    throw new Error('Amount must be between 0.00001 and 1,000,000 NIM.');
  }
  return luna;
}

export function formatLuna(luna: number): string {
  const value = (luna / 100_000).toFixed(5);
  return value.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

export function canonicalizeTerms(terms: SignedOrderTerms): string {
  return JSON.stringify({
    amountLuna: terms.amountLuna,
    asset: terms.asset,
    code: terms.code,
    description: terms.description,
    expiresAt: terms.expiresAt,
    fulfilmentDigest: terms.fulfilmentDigest,
    fulfilmentReference: terms.fulfilmentReference,
    id: terms.id,
    itemName: terms.itemName,
    memo: terms.memo,
    network: terms.network,
    recipient: terms.recipient,
    revision: terms.revision,
    termsRevision: terms.termsRevision,
  });
}

export function signTerms(terms: SignedOrderTerms, secret: string): string {
  return createHmac('sha256', secret).update(canonicalizeTerms(terms)).digest('hex');
}

export function verifyTermsSignature(
  terms: SignedOrderTerms,
  signature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(signTerms(terms, secret), 'hex');
  const received = Buffer.from(signature, 'hex');
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function buildOrderMemo(code: string, revision: number, identity: string): string {
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const memo = `OS1:${code}:${revision}:${digest}`;
  if (Buffer.byteLength(memo, 'utf8') > 64) throw new Error('Order memo exceeds 64 bytes.');
  return memo;
}

export function decodeRecipientData(hex: string): string {
  if (!hex) return '';
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(hex)) return '';
  return Buffer.from(hex, 'hex').toString('utf8');
}

export function matchPayment(
  terms: SignedOrderTerms,
  transaction: ObservedTransaction,
): PaymentMatch {
  const reasons: string[] = [];
  const decodedMemo = decodeRecipientData(transaction.recipientData);
  if (!transaction.executionResult) reasons.push('execution_result_false');
  if (transaction.networkId !== 24) reasons.push('wrong_network');
  if (normalizeNimiqAddress(transaction.to) !== normalizeNimiqAddress(terms.recipient)) {
    reasons.push('wrong_recipient');
  }
  if (transaction.value !== terms.amountLuna) reasons.push('wrong_amount');
  if (decodedMemo !== terms.memo) reasons.push('wrong_operation_reference');
  return { ok: reasons.length === 0, reasons, decodedMemo };
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
