import { describe, expect, it } from 'vitest';
import {
  buildOrderMemo,
  formatLuna,
  isValidNimiqAddress,
  matchPayment,
  parseNimToLuna,
  signTerms,
  verifyTermsSignature,
  type SignedOrderTerms,
} from './domain.js';

const recipient = 'NQ87 BLXR 6NUY 1TAJ TDTA SP4Y 53DJ X96M CLCK';

function terms(): SignedOrderTerms {
  return {
    id: '52a12a96-2a8c-49eb-9771-6504c3b76404',
    code: 'ORDER12345',
    revision: 1,
    itemName: 'Settlement report',
    description: 'A signed delivery',
    recipient,
    amountLuna: 125_001,
    asset: 'NIM',
    network: 'mainnet',
    expiresAt: '2030-01-01T00:00:00.000Z',
    fulfilmentReference: 'REPORT-1',
    fulfilmentDigest: 'f'.repeat(64),
    termsRevision: 1,
    memo: 'OS1:ORDER12345:1:0123456789ab',
  };
}

describe('Nimiq domain controls', () => {
  it('validates the Nimiq IBAN checksum rather than only its shape', () => {
    expect(isValidNimiqAddress(recipient)).toBe(true);
    expect(isValidNimiqAddress('NQ87 BLXR 6NUY 1TAJ TDTA SP4Y 53DJ X96M CLCJ')).toBe(false);
  });

  it('converts decimal NIM without floating point rounding', () => {
    expect(parseNimToLuna('1.25001')).toBe(125_001);
    expect(formatLuna(125_001)).toBe('1.25001');
    expect(() => parseNimToLuna('0.000001')).toThrow(/5 decimal/);
    expect(() => parseNimToLuna('1e3')).toThrow();
  });

  it('signs canonical terms and detects mutation', () => {
    const signed = terms();
    const signature = signTerms(signed, 'x'.repeat(32));
    expect(verifyTermsSignature(signed, signature, 'x'.repeat(32))).toBe(true);
    expect(verifyTermsSignature({ ...signed, amountLuna: signed.amountLuna + 1 }, signature, 'x'.repeat(32))).toBe(false);
  });

  it('binds the exact recipient, amount, network, execution result, and memo', () => {
    const signed = terms();
    const base = {
      hash: 'a'.repeat(64),
      blockNumber: 10,
      timestamp: 1_800_000_000,
      confirmations: 10,
      from: recipient,
      to: recipient,
      value: signed.amountLuna,
      recipientData: Buffer.from(signed.memo).toString('hex'),
      networkId: 24,
      executionResult: true,
    };
    expect(matchPayment(signed, base)).toEqual({ ok: true, reasons: [], decodedMemo: signed.memo });
    expect(matchPayment(signed, {
      ...base,
      value: base.value + 1,
      networkId: 5,
      executionResult: false,
      recipientData: Buffer.from('another order').toString('hex'),
    }).reasons).toEqual([
      'execution_result_false',
      'wrong_network',
      'wrong_amount',
      'wrong_operation_reference',
    ]);
  });

  it('keeps the public operation reference within Nimiq transaction data limits', () => {
    const memo = buildOrderMemo('23456789AB', 1, 'unique-order-identity');
    expect(Buffer.byteLength(memo)).toBeLessThanOrEqual(64);
    expect(memo).toMatch(/^OS1:23456789AB:1:[0-9a-f]{12}$/);
  });
});
