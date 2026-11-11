import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  buildOrderMemo,
  formatLuna,
  isValidNimiqAddress,
  normalizeNimiqAddress,
  parseNimToLuna,
  sha256Text,
  signTerms,
  type SignedOrderTerms,
} from '../shared/domain.js';
import type { OrderSummary, PublicOrderView } from '../shared/api.js';
import type { AppConfig } from './config.js';
import type { ChainClient } from './chain.js';
import {
  bindOperationAlias,
  getActiveMerchantConfig,
  getFulfilment,
  getOperationBySemanticKey,
  getOperationById,
  getOrderById,
  getOrderByPublicToken,
  getPaymentAttemptByHash,
  getPaymentOperation,
  listOrders,
  type OrderRow,
  type OperationRow,
} from './db.js';
import { reconcileAllPayments, reconcilePaymentOperation } from './reconcile.js';
import { verifyOrderIntegrity } from './integrity.js';

export interface AppDependencies {
  config: AppConfig;
  db: Database.Database;
  chain: ChainClient;
  serveStatic?: boolean;
}

const merchantConfigSchema = z.object({
  recipient: z.string().min(1).max(64),
});

const createOrderSchema = z.object({
  itemName: z.string().trim().min(2).max(120),
  description: z.string().trim().min(2).max(500),
  amountNim: z.string().trim().min(1).max(32),
  expiresInMinutes: z.number().int().min(5).max(10_080),
  fulfilmentReference: z.string().trim().min(2).max(120),
  fulfilmentMessage: z.string().trim().min(2).max(1_500),
});

const paymentAttemptSchema = z.object({
  txHash: z.string().regex(/^[0-9a-f]{64}$/i),
  hostNetwork: z.literal('mainnet'),
  idempotencyKey: z.string().min(8).max(128).regex(/^[a-zA-Z0-9._:-]+$/),
});

function apiError(reply: FastifyReply, status: number, code: string, message: string, fields?: Record<string, string>) {
  return reply.status(status).send({ error: { code, message, ...(fields ? { fields } : {}) } });
}

function secureEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function makeCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(10);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function nowIso(): string {
  return new Date().toISOString();
}

const IMMUTABLE_PAYMENT_STATES = new Set(['FULFILLED', 'REFUNDED', 'CONFLICT']);

function recordRejectedPaymentSubmission(
  db: Database.Database,
  orderId: string,
  attemptedTxHash: string,
  semanticKey: string,
  reason: string,
  canonicalTxHash: string | null,
): void {
  db.prepare(`
    INSERT INTO audit_events(id, order_id, actor, action, data_json, created_at)
    VALUES (?, ?, 'customer', 'payment_submission_rejected', ?, ?)
  `).run(
    randomUUID(), orderId,
    JSON.stringify({ reason, attemptedTxHash, canonicalTxHash, semanticKey }),
    nowIso(),
  );
}

function summary(row: OrderRow): OrderSummary {
  return {
    id: row.id,
    code: row.code,
    publicToken: row.public_token,
    state: row.state,
    itemName: row.item_name,
    amountLuna: row.amount_luna,
    recipient: row.recipient,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paymentTxHash: row.payment_tx_hash,
    paymentConfirmations: row.payment_confirmations,
    conflictReasons: JSON.parse(row.conflict_reasons) as string[],
    refundExecution: 'OBSERVATION_ONLY',
  };
}

function publicView(
  db: Database.Database,
  row: OrderRow,
  config: AppConfig,
  submittedOperation?: OperationRow | null,
): PublicOrderView {
  const fulfilment = getFulfilment(db, row.id);
  const integrity = verifyOrderIntegrity(row, config.signingSecret);
  if (!integrity.ok || !integrity.terms) throw new Error(`ORDER_INTEGRITY_FAILURE:${integrity.reasons.join(',')}`);
  const age = row.last_observed_at ? Date.now() - Date.parse(row.last_observed_at) : null;
  let attemptReasons: string[] = [];
  if (submittedOperation?.outcome_json) {
    try {
      const outcome = JSON.parse(submittedOperation.outcome_json) as { reasons?: unknown; reason?: unknown };
      if (Array.isArray(outcome.reasons)) attemptReasons = outcome.reasons.filter((value): value is string => typeof value === 'string');
      else if (typeof outcome.reason === 'string') attemptReasons = [outcome.reason];
    } catch {
      attemptReasons = ['invalid_observer_evidence'];
    }
  }
  return {
    ...summary(row),
    terms: integrity.terms,
    signature: row.signature,
    observer: {
      source: new URL(config.rpcUrl).hostname,
      lastCheckedAt: row.last_observed_at,
      requiredConfirmations: config.requiredConfirmations,
      freshness: age === null ? 'not_checked' : age <= 30_000 ? 'fresh' : 'stale',
    },
    fulfilment: row.state === 'FULFILLED' && fulfilment?.state === 'RELEASED'
      ? { reference: row.fulfilment_reference, message: row.fulfilment_message, releasedAt: fulfilment.released_at }
      : null,
    refund: {
      execution: 'UNSUPPORTED',
      mode: 'OBSERVATION_ONLY',
      finalizedLuna: row.refund_finalized_luna,
    },
    ...(submittedOperation?.tx_hash ? {
      submittedAttempt: {
        txHash: submittedOperation.tx_hash,
        state: submittedOperation.state,
        reasons: attemptReasons,
      },
    } : {}),
  };
}

function maybeExpire(db: Database.Database, row: OrderRow): OrderRow {
  const nonterminal = ['OFFERED', 'AWAITING_PAYMENT'];
  if (nonterminal.includes(row.state) && Date.now() > Date.parse(row.expires_at)) {
    const timestamp = nowIso();
    db.prepare(`
      UPDATE orders SET state = 'EXPIRED', updated_at = ?, version = version + 1
      WHERE id = ? AND state IN ('OFFERED', 'AWAITING_PAYMENT')
    `).run(timestamp, row.id);
    return getOrderById(db, row.id) ?? row;
  }
  return row;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, db, chain } = dependencies;
  const app = Fastify({
    logger: {
      level: config.nodeEnv === 'test' ? 'silent' : 'info',
      redact: ['req.headers.authorization', 'headers.authorization', 'adminToken', 'signingSecret'],
    },
    bodyLimit: 32 * 1024,
    // Railway is publicly reachable, so client-supplied forwarding headers
    // must never become rate-limit identity.
    trustProxy: false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
      },
    },
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const token = (request.params as { token?: unknown } | undefined)?.token;
      if (typeof token === 'string') {
        return `public:${createHash('sha256').update(token).digest('hex')}`;
      }
      return request.ip;
    },
  });

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ') || !secureEquals(header.slice(7), config.adminToken)) {
      return apiError(reply, 401, 'ADMIN_AUTH_REQUIRED', 'Enter the merchant operator token.');
    }
  };

  app.get('/health', async () => ({
    status: 'ok',
    database: db.prepare('SELECT 1 AS ok').get(),
    observer: new URL(config.rpcUrl).hostname,
  }));

  app.get('/api/meta', async () => ({
    name: 'OrderSeal',
    asset: 'NIM',
    network: 'mainnet',
    miniAppSdk: '0.2.5',
    requiredConfirmations: config.requiredConfirmations,
    refundExecution: 'UNSUPPORTED',
    refundMode: 'OBSERVATION_ONLY',
    nimiqPayDeepLinkPrefix: 'nimiqpay://miniapp?url=',
  }));

  app.get('/api/admin/merchant-config', { preHandler: requireAdmin }, async (_request, reply) => {
    const merchant = getActiveMerchantConfig(db);
    if (!merchant) return apiError(reply, 404, 'MERCHANT_NOT_CONFIGURED', 'Configure a mainnet receiving address first.');
    return {
      recipient: merchant.recipient,
      network: merchant.network,
      revision: merchant.revision,
      verifiedAt: merchant.verified_at,
    };
  });

  app.post('/api/admin/merchant-config', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = merchantConfigSchema.safeParse(request.body);
    if (!parsed.success) return apiError(reply, 400, 'INVALID_MERCHANT_CONFIG', 'Check the receiving address.');
    if (!isValidNimiqAddress(parsed.data.recipient)) {
      return apiError(reply, 400, 'INVALID_NIMIQ_ADDRESS', 'Enter a valid Nimiq mainnet address.', { recipient: 'Checksum validation failed.' });
    }
    const recipient = normalizeNimiqAddress(parsed.data.recipient);
    const timestamp = nowIso();
    const current = getActiveMerchantConfig(db);
    const revision = (current?.revision ?? 0) + 1;
    db.transaction(() => {
      db.prepare('UPDATE merchant_configs SET active = 0 WHERE active = 1').run();
      db.prepare(`
        INSERT INTO merchant_configs(revision, recipient, network, verified_at, active)
        VALUES (?, ?, 'mainnet', ?, 1)
      `).run(revision, recipient, timestamp);
      db.prepare(`
        INSERT INTO audit_events(id, order_id, actor, action, data_json, created_at)
        VALUES (?, NULL, 'merchant', 'merchant_configured', ?, ?)
      `).run(randomUUID(), JSON.stringify({ recipient, network: 'mainnet', revision }), timestamp);
    })();
    return reply.status(201).send({ recipient, network: 'mainnet', revision, verifiedAt: timestamp });
  });

  app.post('/api/admin/orders', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = createOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      const fields = Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]));
      return apiError(reply, 400, 'INVALID_ORDER', 'Review the highlighted fields.', fields);
    }
    const merchant = getActiveMerchantConfig(db);
    if (!merchant) return apiError(reply, 409, 'MERCHANT_NOT_CONFIGURED', 'Configure a receiving address before creating an order.');

    let amountLuna: number;
    try {
      amountLuna = parseNimToLuna(parsed.data.amountNim);
    } catch (error) {
      return apiError(reply, 400, 'INVALID_AMOUNT', error instanceof Error ? error.message : 'Invalid amount.', { amountNim: 'Use at most 5 decimal places.' });
    }

    const id = randomUUID();
    const code = makeCode();
    const revision = 1;
    const timestamp = nowIso();
    const expiresAt = new Date(Date.now() + parsed.data.expiresInMinutes * 60_000).toISOString();
    const memo = buildOrderMemo(code, revision, `${id}:${merchant.revision}`);
    const terms: SignedOrderTerms = {
      id,
      code,
      revision,
      itemName: parsed.data.itemName,
      description: parsed.data.description,
      recipient: merchant.recipient,
      amountLuna,
      asset: 'NIM',
      network: 'mainnet',
      expiresAt,
      fulfilmentReference: parsed.data.fulfilmentReference,
      fulfilmentDigest: sha256Text(parsed.data.fulfilmentMessage),
      termsRevision: merchant.revision,
      memo,
    };
    const signature = signTerms(terms, config.signingSecret);
    const publicToken = randomBytes(24).toString('base64url');
    db.transaction(() => {
      db.prepare(`
        INSERT INTO orders(
          id, code, public_token, revision, item_name, description, recipient,
          amount_luna, asset, network, expires_at, fulfilment_reference,
          fulfilment_message, memo, terms_json, signature, state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NIM', 'mainnet', ?, ?, ?, ?, ?, ?, 'OFFERED', ?, ?)
      `).run(
        id, code, publicToken, revision, terms.itemName, terms.description, terms.recipient,
        amountLuna, expiresAt, terms.fulfilmentReference, parsed.data.fulfilmentMessage,
        memo, JSON.stringify(terms), signature, timestamp, timestamp,
      );
      db.prepare(`
        INSERT INTO audit_events(id, order_id, actor, action, data_json, created_at)
        VALUES (?, ?, 'merchant', 'order_signed', ?, ?)
      `).run(randomUUID(), id, JSON.stringify({ code, amountLuna, signature }), timestamp);
    })();
    const order = getOrderById(db, id)!;
    return reply.status(201).send({
      ...summary(order),
      amountNim: formatLuna(amountLuna),
      checkoutUrl: `${config.publicOrigin}/pay/${publicToken}`,
      signature,
      memo,
    });
  });

  app.get('/api/admin/orders', { preHandler: requireAdmin }, async () => ({
    orders: listOrders(db).map(summary),
  }));

  app.get('/api/admin/orders/:id', { preHandler: requireAdmin }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return apiError(reply, 400, 'INVALID_ORDER_ID', 'Order ID is invalid.');
    const order = getOrderById(db, id.data);
    if (!order) return apiError(reply, 404, 'ORDER_NOT_FOUND', 'Order was not found.');
    const integrity = verifyOrderIntegrity(order, config.signingSecret);
    if (!integrity.ok) return apiError(reply, 500, 'ORDER_INTEGRITY_FAILURE', 'This order failed its integrity check. Do not act on it.');
    return publicView(db, order, config);
  });

  app.get('/api/public/orders/:token', async (request, reply) => {
    const token = z.string().min(20).max(64).safeParse((request.params as { token?: unknown }).token);
    if (!token.success) return apiError(reply, 404, 'ORDER_NOT_FOUND', 'Order was not found.');
    let order = getOrderByPublicToken(db, token.data);
    if (!order) return apiError(reply, 404, 'ORDER_NOT_FOUND', 'Order was not found.');
    const integrity = verifyOrderIntegrity(order, config.signingSecret);
    if (!integrity.ok) {
      request.log.error({ orderId: order.id, reasons: integrity.reasons }, 'Order integrity verification failed.');
      return apiError(reply, 500, 'ORDER_INTEGRITY_FAILURE', 'This order failed its integrity check. Do not pay it.');
    }
    order = maybeExpire(db, order);
    return publicView(db, order, config);
  });

  app.post('/api/public/orders/:token/payment-attempt', {
    config: {
      rateLimit: {
        max: 15,
        timeWindow: '1 minute',
        keyGenerator: (request: FastifyRequest) => {
          const candidate = (request.params as { token?: unknown }).token;
          return `payment:${typeof candidate === 'string'
            ? createHash('sha256').update(candidate).digest('hex')
            : 'invalid-token'}`;
        },
      },
    },
  }, async (request, reply) => {
    const token = z.string().min(20).max(64).safeParse((request.params as { token?: unknown }).token);
    const parsed = paymentAttemptSchema.safeParse(request.body);
    if (!token.success || !parsed.success) {
      return apiError(reply, 400, 'INVALID_PAYMENT_ATTEMPT', 'Transaction hash, host network, or operation identity is invalid.');
    }
    const found = getOrderByPublicToken(db, token.data);
    if (!found) return apiError(reply, 404, 'ORDER_NOT_FOUND', 'Order was not found.');
    const integrity = verifyOrderIntegrity(found, config.signingSecret);
    if (!integrity.ok) {
      db.prepare(`
        INSERT INTO audit_events(id, order_id, actor, action, data_json, created_at)
        VALUES (?, ?, 'system', 'order_integrity_failure', ?, ?)
      `).run(randomUUID(), found.id, JSON.stringify({ context: 'payment_attempt', reasons: integrity.reasons }), nowIso());
      request.log.error({ orderId: found.id, reasons: integrity.reasons }, 'Rejected payment claim for an invalid order.');
      return apiError(reply, 500, 'ORDER_INTEGRITY_FAILURE', 'This order failed its integrity check. No payment claim was recorded.');
    }
    const order = maybeExpire(db, found);
    const txHash = parsed.data.txHash.toLowerCase();
    const semanticKey = `pay:${order.id}:${parsed.data.idempotencyKey}`;

    const respondForOperation = async (operation: NonNullable<ReturnType<typeof getPaymentOperation>>) => {
      const before = getOrderById(db, order.id)!;
      if (
        !IMMUTABLE_PAYMENT_STATES.has(before.state)
        && ['REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN'].includes(operation.state)
      ) {
        await reconcilePaymentOperation(db, chain, operation, config.requiredConfirmations, config.signingSecret);
      }
      const latest = getOrderById(db, order.id)!;
      const latestOperation = getOperationById(db, operation.id);
      return reply.status(IMMUTABLE_PAYMENT_STATES.has(latest.state) ? 200 : 202)
        .send(publicView(db, latest, config, latestOperation));
    };

    const existingForKey = getOperationBySemanticKey(db, semanticKey);
    if (existingForKey) {
      if (existingForKey.tx_hash?.toLowerCase() === txHash) return respondForOperation(existingForKey);
      recordRejectedPaymentSubmission(
        db, order.id, txHash, semanticKey, 'idempotency_key_payload_mismatch', existingForKey.tx_hash,
      );
      return apiError(reply, 409, 'IDEMPOTENCY_KEY_REUSED', 'This operation identity is already bound to a different transaction.');
    }

    const existingPayment = getPaymentOperation(db, order.id);
    if (existingPayment) {
      if (existingPayment.tx_hash?.toLowerCase() === txHash) {
        bindOperationAlias(db, semanticKey, existingPayment, nowIso());
        return respondForOperation(existingPayment);
      }
      const terminal = IMMUTABLE_PAYMENT_STATES.has(order.state);
      recordRejectedPaymentSubmission(
        db, order.id, txHash, semanticKey,
        terminal ? 'terminal_order_is_immutable' : 'canonical_payment_hash_already_claimed',
        existingPayment.tx_hash,
      );
      return apiError(
        reply,
        409,
        terminal ? 'ORDER_PAYMENT_FINALIZED' : 'PAYMENT_HASH_ALREADY_CLAIMED',
        terminal
          ? 'This order is final. A later transaction hash cannot change its state.'
          : 'This order already has a canonical payment transaction. The attempted hash was preserved in the audit trail.',
      );
    }

    const existingAttempt = getPaymentAttemptByHash(db, order.id, txHash);
    if (existingAttempt) {
      bindOperationAlias(db, semanticKey, existingAttempt, nowIso());
      return respondForOperation(existingAttempt);
    }

    if (IMMUTABLE_PAYMENT_STATES.has(order.state)) {
      recordRejectedPaymentSubmission(db, order.id, txHash, semanticKey, 'terminal_order_is_immutable', null);
      return apiError(reply, 409, 'ORDER_PAYMENT_FINALIZED', 'This order is final and cannot accept a payment transaction.');
    }

    const operationId = randomUUID();
    const timestamp = nowIso();
    try {
      db.transaction(() => {
        const current = getOrderById(db, order.id);
        if (!current || IMMUTABLE_PAYMENT_STATES.has(current.state) || getPaymentOperation(db, order.id)) {
          throw new Error('PAYMENT_ATTEMPT_RACE');
        }
        db.prepare(`
          INSERT INTO operations(id, order_id, type, semantic_key, state, tx_hash, retry_fenced, created_at, updated_at)
          VALUES (?, ?, 'PAYMENT_ATTEMPT', ?, 'REQUESTED', ?, 1, ?, ?)
        `).run(operationId, order.id, semanticKey, txHash, timestamp, timestamp);
        db.prepare(`
          INSERT INTO audit_events(id, order_id, actor, action, data_json, created_at)
          VALUES (?, ?, 'customer', 'payment_attempt_submitted', ?, ?)
        `).run(randomUUID(), order.id, JSON.stringify({ txHash, hostNetwork: parsed.data.hostNetwork }), timestamp);
      })();
    } catch (reason) {
      const racedOrder = getOrderById(db, order.id)!;
      const raced = getPaymentAttemptByHash(db, order.id, txHash) ?? getPaymentOperation(db, order.id);
      if (raced?.tx_hash?.toLowerCase() === txHash) {
        bindOperationAlias(db, semanticKey, raced, nowIso());
        return respondForOperation(raced);
      }
      recordRejectedPaymentSubmission(
        db, order.id, txHash, semanticKey, 'concurrent_payment_attempt_lost', raced?.tx_hash ?? null,
      );
      if (raced || IMMUTABLE_PAYMENT_STATES.has(racedOrder.state)) {
        return apiError(reply, 409, 'PAYMENT_HASH_ALREADY_CLAIMED', 'Another exact payment became canonical first. No order state was overwritten.');
      }
      throw reason;
    }
    return respondForOperation(getPaymentAttemptByHash(db, order.id, txHash)!);
  });

  app.post('/api/admin/orders/:id/reconcile', { preHandler: requireAdmin }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: unknown }).id);
    if (!id.success) return apiError(reply, 400, 'INVALID_ORDER_ID', 'Order ID is invalid.');
    const operation = getPaymentOperation(db, id.data);
    if (!operation) return apiError(reply, 409, 'NO_PAYMENT_TO_RECONCILE', 'This order has no submitted payment transaction.');
    const result = await reconcilePaymentOperation(db, chain, operation, config.requiredConfirmations, config.signingSecret);
    return { result, order: publicView(db, getOrderById(db, id.data)!, config) };
  });

  app.post('/api/admin/reconcile', { preHandler: requireAdmin }, async () => ({
    results: await reconcileAllPayments(db, chain, config.requiredConfirmations, config.signingSecret),
  }));

  app.post('/api/admin/orders/:id/refunds/observe', { preHandler: requireAdmin }, async (_request, reply) => {
    return apiError(
      reply,
      501,
      'REFUND_EXECUTION_UNSUPPORTED',
      'OrderSeal does not hold merchant signing authority. Refund execution remains observation-only until a separately authorized transaction is supplied.',
    );
  });

  app.all('/api/*', async (_request, reply) => (
    apiError(reply, 404, 'API_ROUTE_NOT_FOUND', 'The requested API route does not exist.')
  ));

  app.setErrorHandler((error, request, reply) => {
    const handled = error as { statusCode?: unknown; message?: unknown };
    const statusCode = typeof handled.statusCode === 'number' ? handled.statusCode : 500;
    if (statusCode === 429) {
      request.log.warn({ statusCode }, 'Request rate limit reached.');
      return apiError(reply, 429, 'RATE_LIMITED', 'Too many requests. Wait before trying again.');
    }
    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn({ statusCode }, 'Request rejected.');
      return apiError(reply, statusCode, 'REQUEST_REJECTED', typeof handled.message === 'string' ? handled.message : 'The request was rejected.');
    }
    request.log.error({ error }, 'Unhandled request error.');
    return apiError(reply, 500, 'INTERNAL_ERROR', 'The request could not be completed. No success state was recorded.');
  });

  const shouldServeStatic = dependencies.serveStatic ?? config.nodeEnv === 'production';
  const currentDir = fileURLToPath(new URL('.', import.meta.url));
  const clientRoot = join(currentDir, '../../client');
  if (shouldServeStatic && existsSync(clientRoot)) {
    await app.register(fastifyStatic, { root: clientRoot, wildcard: false });
    app.get('/*', async (_request, reply) => reply.sendFile('index.html'));
  }

  return app;
}
