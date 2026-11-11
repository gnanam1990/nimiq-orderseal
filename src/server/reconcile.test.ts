import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { buildOrderMemo, sha256Text, signTerms, type ObservedTransaction, type SignedOrderTerms } from '../shared/domain.js';
import type { ChainClient, ChainObservation } from './chain.js';
import { getOrderById, getPaymentOperation, openDatabase } from './db.js';
import { reconcileAllPayments, reconcilePaymentOperation } from './reconcile.js';

const recipient = 'NQ87 BLXR 6NUY 1TAJ TDTA SP4Y 53DJ X96M CLCK';
const databases: Database.Database[] = [];

function fixture(): { db: Database.Database; orderId: string; operationId: string; terms: SignedOrderTerms } {
  const db = openDatabase(':memory:');
  databases.push(db);
  const orderId = randomUUID();
  const operationId = randomUUID();
  const code = 'ORDER12345';
  const memo = buildOrderMemo(code, 1, orderId);
  const fulfilmentMessage = 's3://protected/object';
  const terms: SignedOrderTerms = {
    id: orderId,
    code,
    revision: 1,
    itemName: 'Release bundle',
    description: 'A protected digital delivery',
    recipient,
    amountLuna: 250_000,
    asset: 'NIM',
    network: 'mainnet',
    expiresAt: '2030-01-01T00:00:00.000Z',
    fulfilmentReference: 'BUNDLE-42',
    fulfilmentDigest: sha256Text(fulfilmentMessage),
    termsRevision: 1,
    memo,
  };
  const timestamp = '2029-01-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO orders(
      id, code, public_token, revision, item_name, description, recipient,
      amount_luna, asset, network, expires_at, fulfilment_reference,
      fulfilment_message, memo, terms_json, signature, state, payment_tx_hash,
      created_at, updated_at
    ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'NIM', 'mainnet', ?, ?, ?, ?, ?, ?, 'TRANSACTION_SEEN', ?, ?, ?)
  `).run(
    orderId, code, 't'.repeat(32), terms.itemName, terms.description, recipient,
    terms.amountLuna, terms.expiresAt, terms.fulfilmentReference, fulfilmentMessage,
    memo, JSON.stringify(terms), signTerms(terms, 'x'.repeat(32)), 'a'.repeat(64), timestamp, timestamp,
  );
  db.prepare(`
    INSERT INTO operations(id, order_id, type, semantic_key, state, tx_hash, retry_fenced, created_at, updated_at)
    VALUES (?, ?, 'PAYMENT_OBSERVATION', ?, 'REQUESTED', ?, 1, ?, ?)
  `).run(operationId, orderId, `pay:${orderId}:fixture`, 'a'.repeat(64), timestamp, timestamp);
  return { db, orderId, operationId, terms };
}

function transaction(terms: SignedOrderTerms, overrides: Partial<ObservedTransaction> = {}): ObservedTransaction {
  return {
    hash: 'a'.repeat(64),
    blockNumber: 100,
    timestamp: 1_861_920_000,
    confirmations: 12,
    from: recipient,
    to: terms.recipient,
    value: terms.amountLuna,
    recipientData: Buffer.from(terms.memo).toString('hex'),
    networkId: 24,
    executionResult: true,
    ...overrides,
  };
}

function chain(observation: ChainObservation | Error): ChainClient {
  return {
    observeTransaction: async () => {
      if (observation instanceof Error) throw observation;
      return observation;
    },
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('payment reconciliation', () => {
  it('releases fulfilment exactly once after an exact final payment', async () => {
    const { db, orderId, operationId, terms } = fixture();
    const operation = getPaymentOperation(db, orderId)!;
    const observer = chain({ transaction: transaction(terms), headBlock: 111, confirmations: 12, source: 'test-rpc' });
    expect((await reconcilePaymentOperation(db, observer, operation, 10, 'x'.repeat(32))).state).toBe('FULFILLED');
    expect((await reconcilePaymentOperation(db, observer, operation, 10, 'x'.repeat(32))).state).toBe('FULFILLED');
    expect(getOrderById(db, orderId)?.state).toBe('FULFILLED');
    expect(db.prepare('SELECT COUNT(*) AS count FROM fulfilments WHERE order_id = ?').get(orderId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'payment_finalized_and_fulfilment_released'").get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT state FROM operations WHERE id = ?').get(operationId)).toEqual({ state: 'CONFIRMED_APPLIED' });
  });

  it('keeps low-confirmation settlement pending', async () => {
    const { db, orderId, terms } = fixture();
    const result = await reconcilePaymentOperation(
      db,
      chain({ transaction: transaction(terms, { confirmations: 2 }), headBlock: 101, confirmations: 2, source: 'test-rpc' }),
      getPaymentOperation(db, orderId)!,
      10,
      'x'.repeat(32),
    );
    expect(result.state).toBe('FINALITY_PENDING');
    expect(db.prepare('SELECT COUNT(*) AS count FROM fulfilments').get()).toEqual({ count: 0 });
  });

  it('records deterministic tuple mismatch as a terminal conflict', async () => {
    const { db, orderId, terms } = fixture();
    const result = await reconcilePaymentOperation(
      db,
      chain({ transaction: transaction(terms, { value: terms.amountLuna + 1 }), headBlock: 111, confirmations: 12, source: 'test-rpc' }),
      getPaymentOperation(db, orderId)!,
      10,
      'x'.repeat(32),
    );
    expect(result).toMatchObject({ state: 'CONFLICT', reasons: ['wrong_amount'] });
    expect(db.prepare('SELECT COUNT(*) AS count FROM fulfilments').get()).toEqual({ count: 0 });
  });

  it('fences an unavailable observer as unknown instead of unpaid', async () => {
    const { db, orderId } = fixture();
    const result = await reconcilePaymentOperation(
      db, chain(new Error('RPC timed out')), getPaymentOperation(db, orderId)!, 10, 'x'.repeat(32),
    );
    expect(result).toMatchObject({ state: 'PAYMENT_OBSERVATION_UNKNOWN', reasons: ['observer_unavailable'] });
    expect(db.prepare('SELECT state, retry_fenced FROM operations WHERE order_id = ?').get(orderId))
      .toEqual({ state: 'OUTCOME_UNKNOWN', retry_fenced: 1 });
  });

  it('treats Unix-second timestamps after signed expiry as late', async () => {
    const { db, orderId, terms } = fixture();
    const lateSeconds = Math.floor(Date.parse(terms.expiresAt) / 1_000) + 1;
    const result = await reconcilePaymentOperation(
      db,
      chain({ transaction: transaction(terms, { timestamp: lateSeconds }), headBlock: 111, confirmations: 12, source: 'test-rpc' }),
      getPaymentOperation(db, orderId)!,
      10,
      'x'.repeat(32),
    );
    expect(result).toMatchObject({ state: 'CONFLICT', reasons: ['late_payment'] });
  });

  it('does not release a delivery whose protected payload no longer matches signed terms', async () => {
    const { db, orderId, terms } = fixture();
    db.prepare('UPDATE orders SET fulfilment_message = ? WHERE id = ?').run('swapped delivery', orderId);
    const result = await reconcilePaymentOperation(
      db,
      chain({ transaction: transaction(terms), headBlock: 111, confirmations: 12, source: 'test-rpc' }),
      getPaymentOperation(db, orderId)!,
      10,
      'x'.repeat(32),
    );
    expect(result.state).toBe('CONFLICT');
    expect(result.reasons).toContain('fulfilment_digest_mismatch');
    expect(db.prepare('SELECT COUNT(*) AS count FROM fulfilments').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT state FROM operations WHERE order_id = ?').get(orderId)).toEqual({ state: 'REJECTED' });
  });

  it('does not background-poll public attempts or let stale attempts starve canonical reconciliation', async () => {
    const { db, orderId, terms } = fixture();
    const timestamp = '2029-01-01T00:00:00.000Z';
    for (let index = 1; index <= 101; index += 1) {
      db.prepare(`
        INSERT INTO operations(id, order_id, type, semantic_key, state, tx_hash, retry_fenced, created_at, updated_at)
        VALUES (?, ?, 'PAYMENT_ATTEMPT', ?, 'OUTCOME_UNKNOWN', ?, 1, ?, ?)
      `).run(
        randomUUID(), orderId, `attempt:${index}`, index.toString(16).padStart(64, '0'), timestamp, timestamp,
      );
    }
    let rpcCalls = 0;
    const observer: ChainClient = {
      observeTransaction: async () => {
        rpcCalls += 1;
        return { transaction: transaction(terms), headBlock: 111, confirmations: 12, source: 'test-rpc' };
      },
    };
    const results = await reconcileAllPayments(db, observer, 10, 'x'.repeat(32));
    expect(results).toHaveLength(1);
    expect(results[0]?.state).toBe('FULFILLED');
    expect(rpcCalls).toBe(1);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM operations
      WHERE type = 'PAYMENT_ATTEMPT' AND state IN ('REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN')
    `).get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM fulfilments WHERE order_id = ?').get(orderId))
      .toEqual({ count: 1 });
  });
});
