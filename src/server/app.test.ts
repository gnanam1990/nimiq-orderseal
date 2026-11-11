import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import type { ChainClient, ChainObservation } from './chain.js';
import { buildApp } from './app.js';
import { openDatabase } from './db.js';

const recipient = 'NQ87 BLXR 6NUY 1TAJ TDTA SP4Y 53DJ X96M CLCK';
const config: AppConfig = {
  nodeEnv: 'test',
  port: 3000,
  dbPath: ':memory:',
  adminToken: 'operator-token-is-long-enough',
  signingSecret: 's'.repeat(32),
  rpcUrl: 'https://rpc.nimiqwatch.com',
  requiredConfirmations: 10,
  publicOrigin: 'https://orderseal.example',
  observerIntervalMs: 7_000,
};
const resources: Array<{ app: FastifyInstance; db: Database.Database }> = [];

async function setup(delayMs = 0) {
  const db = openDatabase(':memory:');
  let observation: ChainObservation | null = null;
  const chain: ChainClient = {
    observeTransaction: async (hash) => {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!observation) throw new Error('test observation not configured');
      if (hash === 'f'.repeat(64)) return { transaction: null, headBlock: 111, confirmations: 0, source: 'test-rpc' };
      return observation;
    },
  };
  const app = await buildApp({ config, db, chain, serveStatic: false });
  resources.push({ app, db });
  const auth = { authorization: `Bearer ${config.adminToken}` };
  const merchant = await app.inject({
    method: 'POST',
    url: '/api/admin/merchant-config',
    headers: auth,
    payload: { recipient },
  });
  expect(merchant.statusCode).toBe(201);
  const created = await app.inject({
    method: 'POST',
    url: '/api/admin/orders',
    headers: auth,
    payload: {
      itemName: 'Protected research bundle',
      description: 'Delivered only after independent settlement evidence.',
      amountNim: '2.5',
      expiresInMinutes: 60,
      fulfilmentReference: 'ORDERSEAL-DELIVERY',
      fulfilmentMessage: 'https://merchant.example/protected/delivery',
    },
  });
  expect(created.statusCode).toBe(201);
  const order = created.json<{
    id: string;
    publicToken: string;
    memo: string;
    amountLuna: number;
  }>();
  const txHash = 'a'.repeat(64);
  observation = {
    transaction: {
      hash: txHash,
      blockNumber: 100,
      timestamp: Math.floor(Date.now() / 1_000),
      confirmations: 12,
      from: recipient,
      to: recipient,
      value: order.amountLuna,
      recipientData: Buffer.from(order.memo).toString('hex'),
      networkId: 24,
      executionResult: true,
    },
    headBlock: 111,
    confirmations: 12,
    source: 'test-rpc',
  };
  return { app, db, order, txHash };
}

afterEach(async () => {
  for (const { app, db } of resources.splice(0)) {
    await app.close();
    db.close();
  }
});

describe('public payment claim authority', () => {
  it('advertises a full-URL-preserving Nimiq Pay deep-link scheme', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/meta' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      network: 'mainnet',
      miniAppSdk: '0.2.5',
      nimiqPayDeepLinkPrefix: 'nimiqpay://miniapp?url=',
    });
    expect(response.body).not.toContain('nimpay.app/miniapps/open');
  });

  it('reuses a same-hash retry and refuses a later hash without regressing fulfilment', async () => {
    const { app, db, order, txHash } = await setup();
    const first = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash, hostNetwork: 'mainnet', idempotencyKey: 'attempt-one' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ state: 'FULFILLED' });

    const retry = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash, hostNetwork: 'mainnet', idempotencyKey: 'attempt-two' },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ state: 'FULFILLED' });

    const conflicting = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash: 'b'.repeat(64), hostNetwork: 'mainnet', idempotencyKey: 'attempt-three' },
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ error: { code: 'ORDER_PAYMENT_FINALIZED' } });

    const persisted = db.prepare('SELECT state, payment_tx_hash FROM orders WHERE id = ?').get(order.id);
    expect(persisted).toEqual({ state: 'FULFILLED', payment_tx_hash: txHash });
    expect(db.prepare("SELECT COUNT(*) AS count FROM operations WHERE order_id = ? AND type = 'PAYMENT_OBSERVATION'").get(order.id))
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM fulfilments WHERE order_id = ?').get(order.id))
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE order_id = ? AND action = 'payment_submission_rejected'").get(order.id))
      .toEqual({ count: 1 });
  });

  it('atomically chooses one canonical operation under concurrent same-hash submissions', async () => {
    const { app, db, order, txHash } = await setup(20);
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/public/orders/${order.publicToken}/payment-attempt`,
        payload: { txHash, hostNetwork: 'mainnet', idempotencyKey: 'parallel-one' },
      }),
      app.inject({
        method: 'POST',
        url: `/api/public/orders/${order.publicToken}/payment-attempt`,
        payload: { txHash, hostNetwork: 'mainnet', idempotencyKey: 'parallel-two' },
      }),
    ]);
    expect([first.statusCode, second.statusCode].every((status) => status === 200 || status === 202)).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM operations WHERE order_id = ? AND type = 'PAYMENT_OBSERVATION'").get(order.id))
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM fulfilments WHERE order_id = ?').get(order.id))
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE order_id = ? AND action = 'payment_finalized_and_fulfilment_released'").get(order.id))
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT state FROM orders WHERE id = ?').get(order.id)).toEqual({ state: 'FULFILLED' });
  });

  it('does not let an idempotency key bind to a second transaction', async () => {
    const { app, db, order, txHash } = await setup(20);
    const firstPromise = app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash, hostNetwork: 'mainnet', idempotencyKey: 'fixed-operation-key' },
    });
    await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash: 'c'.repeat(64), hostNetwork: 'mainnet', idempotencyKey: 'fixed-operation-key' },
    });
    await firstPromise;
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM operations WHERE order_id = ? AND type = 'PAYMENT_OBSERVATION'").get(order.id))
      .toEqual({ count: 1 });
  });

  it('durably binds a new idempotency alias when it reuses the same unknown hash', async () => {
    const { app, db, order } = await setup();
    const txHash = 'f'.repeat(64);
    const first = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash, hostNetwork: 'mainnet', idempotencyKey: 'unknown-key-a' },
    });
    expect(first.statusCode).toBe(202);
    const alias = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash, hostNetwork: 'mainnet', idempotencyKey: 'unknown-key-b' },
    });
    expect(alias.statusCode).toBe(202);
    const changed = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash: 'e'.repeat(64), hostNetwork: 'mainnet', idempotencyKey: 'unknown-key-b' },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM operations WHERE order_id = ? AND type = 'PAYMENT_ATTEMPT'").get(order.id))
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM operation_aliases WHERE operation_id IN (SELECT id FROM operations WHERE order_id = ?)').get(order.id))
      .toEqual({ count: 1 });
  });

  it('rate-limits by checkout capability despite spoofed forwarded IPs and preserves HTTP 429', async () => {
    const { app, order } = await setup();
    const statuses: number[] = [];
    for (let index = 1; index <= 16; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/public/orders/${order.publicToken}/payment-attempt`,
        headers: { 'x-forwarded-for': `198.51.100.${index}` },
        payload: {
          txHash: index.toString(16).padStart(64, '0'),
          hostNetwork: 'mainnet',
          idempotencyKey: `rate-attempt-${index}`,
        },
      });
      statuses.push(response.statusCode);
      if (index === 16) expect(response.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    }
    expect(statuses.slice(0, 15).every((status) => status === 202)).toBe(true);
    expect(statuses[15]).toBe(429);
  });

  it('fails closed before claiming a payment when signed terms or order columns are tampered', async () => {
    const { app, db, order, txHash } = await setup();
    const stored = db.prepare('SELECT terms_json FROM orders WHERE id = ?').get(order.id) as { terms_json: string };
    const forgedTerms = JSON.parse(stored.terms_json) as { amountLuna: number };
    forgedTerms.amountLuna += 100_000;
    db.prepare('UPDATE orders SET terms_json = ?, amount_luna = ? WHERE id = ?')
      .run(JSON.stringify(forgedTerms), forgedTerms.amountLuna, order.id);

    const response = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash, hostNetwork: 'mainnet', idempotencyKey: 'tampered-order-attempt' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: 'ORDER_INTEGRITY_FAILURE' } });
    expect(db.prepare("SELECT COUNT(*) AS count FROM operations WHERE order_id = ? AND type = 'PAYMENT_OBSERVATION'").get(order.id))
      .toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM fulfilments WHERE order_id = ?').get(order.id))
      .toEqual({ count: 0 });
  });

  it('lets an exact valid payment fulfil after bogus mismatched and unknown public attempts', async () => {
    const { app, db, order, txHash } = await setup();
    const mismatched = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash: 'b'.repeat(64), hostNetwork: 'mainnet', idempotencyKey: 'bogus-mismatch' },
    });
    expect(mismatched.statusCode).toBe(202);
    expect(mismatched.json()).toMatchObject({
      state: 'OFFERED',
      fulfilment: null,
      submittedAttempt: { state: 'REJECTED', reasons: ['wrong_transaction_hash'] },
    });

    const unknown = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash: 'f'.repeat(64), hostNetwork: 'mainnet', idempotencyKey: 'bogus-unknown' },
    });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toMatchObject({
      state: 'OFFERED',
      fulfilment: null,
      submittedAttempt: { state: 'OUTCOME_UNKNOWN', reasons: ['transaction_not_found'] },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM operations WHERE order_id = ? AND type = 'PAYMENT_OBSERVATION'").get(order.id))
      .toEqual({ count: 0 });

    const legitimate = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash, hostNetwork: 'mainnet', idempotencyKey: 'legitimate-payment' },
    });
    expect(legitimate.statusCode).toBe(200);
    expect(legitimate.json()).toMatchObject({ state: 'FULFILLED' });
    expect(db.prepare("SELECT COUNT(*) AS count FROM operations WHERE order_id = ? AND type = 'PAYMENT_ATTEMPT'").get(order.id))
      .toEqual({ count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM operations WHERE order_id = ? AND type = 'PAYMENT_OBSERVATION'").get(order.id))
      .toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM fulfilments WHERE order_id = ?').get(order.id))
      .toEqual({ count: 1 });
  });

  it('serves the integrity-checked order payload, never mutable fulfilment copies', async () => {
    const { app, db, order, txHash } = await setup();
    const paid = await app.inject({
      method: 'POST',
      url: `/api/public/orders/${order.publicToken}/payment-attempt`,
      payload: { txHash, hostNetwork: 'mainnet', idempotencyKey: 'delivery-integrity-payment' },
    });
    expect(paid.statusCode).toBe(200);
    db.prepare('UPDATE fulfilments SET reference = ?, message = ? WHERE order_id = ?')
      .run('EVIL', 'https://evil.example/phish', order.id);

    const publicRead = await app.inject({ method: 'GET', url: `/api/public/orders/${order.publicToken}` });
    expect(publicRead.statusCode).toBe(200);
    expect(publicRead.body).not.toContain('evil.example');
    expect(publicRead.json()).toMatchObject({
      state: 'FULFILLED',
      fulfilment: {
        reference: 'ORDERSEAL-DELIVERY',
        message: 'https://merchant.example/protected/delivery',
      },
    });

    const adminRead = await app.inject({
      method: 'GET',
      url: `/api/admin/orders/${order.id}`,
      headers: { authorization: `Bearer ${config.adminToken}` },
    });
    expect(adminRead.statusCode).toBe(200);
    expect(adminRead.body).not.toContain('evil.example');
  });

  it('never exposes a release fence before the order is fulfilled', async () => {
    const { app, db, order } = await setup();
    db.prepare(`
      INSERT INTO fulfilments(id, order_id, semantic_key, reference, message, state, released_at)
      VALUES ('forged-fence', ?, ?, 'EVIL', 'https://evil.example/phish', 'RELEASED', ?)
    `).run(order.id, `forged:${order.id}`, new Date().toISOString());
    const response = await app.inject({ method: 'GET', url: `/api/public/orders/${order.publicToken}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: 'OFFERED', fulfilment: null });
    expect(response.body).not.toContain('evil.example');
  });

  it('returns JSON 404 for unknown API routes instead of the SPA shell', async () => {
    const { app } = await setup();
    const response = await app.inject({ method: 'GET', url: '/api/no-such-route' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({ error: { code: 'API_ROUTE_NOT_FOUND' } });
  });
});
