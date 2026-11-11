import { z } from 'zod';
import { sha256Text, verifyTermsSignature, type SignedOrderTerms } from '../shared/domain.js';
import type { OrderRow } from './db.js';

const signedTermsSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1),
  revision: z.number().int().positive(),
  itemName: z.string(),
  description: z.string(),
  recipient: z.string(),
  amountLuna: z.number().int().positive(),
  asset: z.literal('NIM'),
  network: z.literal('mainnet'),
  expiresAt: z.string().datetime(),
  fulfilmentReference: z.string(),
  fulfilmentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  termsRevision: z.number().int().positive(),
  memo: z.string().min(1).max(64),
});

export interface OrderIntegrityResult {
  ok: boolean;
  reasons: string[];
  terms: SignedOrderTerms | null;
}

export function verifyOrderIntegrity(row: OrderRow, signingSecret: string): OrderIntegrityResult {
  let raw: unknown;
  try {
    raw = JSON.parse(row.terms_json);
  } catch {
    return { ok: false, reasons: ['invalid_terms_json'], terms: null };
  }
  const parsed = signedTermsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reasons: ['invalid_terms_shape'], terms: null };
  const terms = parsed.data as SignedOrderTerms;
  const reasons: string[] = [];
  if (!verifyTermsSignature(terms, row.signature, signingSecret)) reasons.push('invalid_terms_signature');

  const comparisons: Array<[boolean, string]> = [
    [terms.id === row.id, 'id_mismatch'],
    [terms.code === row.code, 'code_mismatch'],
    [terms.revision === row.revision, 'revision_mismatch'],
    [terms.itemName === row.item_name, 'item_name_mismatch'],
    [terms.description === row.description, 'description_mismatch'],
    [terms.recipient === row.recipient, 'recipient_mismatch'],
    [terms.amountLuna === row.amount_luna, 'amount_mismatch'],
    [terms.asset === row.asset, 'asset_mismatch'],
    [terms.network === row.network, 'network_mismatch'],
    [terms.expiresAt === row.expires_at, 'expiry_mismatch'],
    [terms.fulfilmentReference === row.fulfilment_reference, 'fulfilment_reference_mismatch'],
    [terms.fulfilmentDigest === sha256Text(row.fulfilment_message), 'fulfilment_digest_mismatch'],
    [terms.memo === row.memo, 'memo_mismatch'],
  ];
  for (const [matches, reason] of comparisons) if (!matches) reasons.push(reason);
  return { ok: reasons.length === 0, reasons, terms };
}
