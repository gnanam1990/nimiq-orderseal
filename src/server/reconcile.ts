import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { matchPayment, sha256Json, type OrderState } from '../shared/domain.js';
import type { ChainClient, ChainObservation } from './chain.js';
import {
  getOperationById,
  getOrderById,
  listPaymentOperationsForReconciliation,
  type OperationRow,
  type OrderRow,
} from './db.js';
import { verifyOrderIntegrity } from './integrity.js';

export interface ReconcileResult {
  orderId: string;
  operationId: string;
  state: string;
  reasons: string[];
}

const paymentReconciliationsInFlight = new Map<string, Promise<ReconcileResult>>();

const ACTIVE_OPERATION_STATES = ['REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN'] as const;
const IMMUTABLE_ORDER_STATES = new Set<OrderState>(['FULFILLED', 'REFUNDED', 'CONFLICT']);

function isImmutableOrder(row: OrderRow): boolean {
  return IMMUTABLE_ORDER_STATES.has(row.state);
}

function isActiveOperation(operation: OperationRow): boolean {
  return ACTIVE_OPERATION_STATES.includes(operation.state as typeof ACTIVE_OPERATION_STATES[number]);
}

function currentResult(order: OrderRow, operation: OperationRow, reasons: string[] = []): ReconcileResult {
  return { orderId: order.id, operationId: operation.id, state: order.state, reasons };
}

function closeUnverifiedAttempts(
  db: Database.Database,
  orderId: string,
  observedAt: string,
  reason: string,
): void {
  db.prepare(`
    UPDATE operations SET state = 'CONFIRMED_NOT_APPLIED', retry_fenced = 1,
      outcome_json = ?, updated_at = ?
    WHERE order_id = ? AND type = 'PAYMENT_ATTEMPT'
      AND state IN ('REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN')
  `).run(JSON.stringify({ reason }), observedAt, orderId);
}

function markIntegrityFailure(
  db: Database.Database,
  order: OrderRow,
  operation: OperationRow,
  reasons: string[],
  observedAt: string,
): ReconcileResult {
  if (isImmutableOrder(order)) return currentResult(order, operation, ['order_integrity_failure', ...reasons]);
  const allReasons = ['order_integrity_failure', ...reasons];
  const updated = db.prepare(`
    UPDATE orders SET state = 'CONFLICT', conflict_reasons = ?, updated_at = ?, version = version + 1
    WHERE id = ? AND version = ? AND state NOT IN ('FULFILLED', 'REFUNDED', 'CONFLICT')
  `).run(JSON.stringify(allReasons), observedAt, order.id, order.version);
  if (updated.changes === 0) {
    return currentResult(getOrderById(db, order.id) ?? order, operation, allReasons);
  }
  db.prepare(`
    UPDATE operations SET state = 'REJECTED', retry_fenced = 1, outcome_json = ?, updated_at = ?
    WHERE id = ? AND state IN ('REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN')
  `).run(JSON.stringify({ reasons: allReasons }), observedAt, operation.id);
  closeUnverifiedAttempts(db, order.id, observedAt, 'order_integrity_failure');
  db.prepare(`
    INSERT INTO audit_events(id, order_id, actor, action, data_json, created_at)
    VALUES (?, ?, 'system', 'order_integrity_failure', ?, ?)
  `).run(randomUUID(), order.id, JSON.stringify({ context: 'reconciliation', reasons }), observedAt);
  return { orderId: order.id, operationId: operation.id, state: 'CONFLICT', reasons: allReasons };
}

function transactionTimeMs(timestamp: number): number {
  return timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp;
}

function insertObservation(
  db: Database.Database,
  order: OrderRow,
  operation: OperationRow,
  observation: ChainObservation,
  matchState: string,
  reasons: string[],
  observedAt: string,
): void {
  const transaction = observation.transaction;
  if (!transaction) return;
  db.prepare(`
    INSERT INTO observations(
      id, order_id, operation_id, tx_hash, source, raw_digest, block_number,
      confirmations, execution_result, from_address, to_address, value_luna,
      recipient_data, match_state, mismatch_reasons, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    randomUUID(), order.id, operation.id, transaction.hash,
    observation.source, sha256Json(transaction), transaction.blockNumber,
    observation.confirmations, transaction.executionResult ? 1 : 0,
    transaction.from, transaction.to, transaction.value,
    transaction.recipientData, matchState, JSON.stringify(reasons), observedAt,
  );
}

function applyUnknownOutcome(
  db: Database.Database,
  orderId: string,
  operationId: string,
  observedAt: string,
  outcome: Record<string, unknown>,
  signingSecret: string,
): ReconcileResult {
  return db.transaction(() => {
    const order = getOrderById(db, orderId);
    const operation = getOperationById(db, operationId);
    if (!order || !operation) {
      return { orderId, operationId, state: 'REJECTED', reasons: ['missing_order_or_operation'] };
    }
    const integrity = verifyOrderIntegrity(order, signingSecret);
    if (!integrity.ok) return markIntegrityFailure(db, order, operation, integrity.reasons, observedAt);
    if (isImmutableOrder(order)) return currentResult(order, operation);

    if (operation.type === 'PAYMENT_ATTEMPT') {
      db.prepare(`
        UPDATE operations SET state = 'OUTCOME_UNKNOWN', retry_fenced = 1,
          outcome_json = ?, updated_at = ?
        WHERE id = ? AND state IN ('REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN')
      `).run(JSON.stringify(outcome), observedAt, operation.id);
      return {
        orderId: order.id,
        operationId: operation.id,
        state: 'PAYMENT_OBSERVATION_UNKNOWN',
        reasons: [String(outcome.reason ?? 'observer_unavailable')],
      };
    }

    const updated = db.prepare(`
      UPDATE orders SET state = 'PAYMENT_OBSERVATION_UNKNOWN', last_observed_at = ?,
        updated_at = ?, version = version + 1
      WHERE id = ? AND version = ? AND state NOT IN ('FULFILLED', 'REFUNDED', 'CONFLICT')
    `).run(observedAt, observedAt, order.id, order.version);
    if (updated.changes === 0) {
      return currentResult(getOrderById(db, order.id) ?? order, operation);
    }
    db.prepare(`
      UPDATE operations SET state = 'OUTCOME_UNKNOWN', retry_fenced = 1,
        outcome_json = ?, updated_at = ?
      WHERE id = ? AND state IN ('REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN')
    `).run(JSON.stringify(outcome), observedAt, operation.id);
    return {
      orderId: order.id,
      operationId: operation.id,
      state: 'PAYMENT_OBSERVATION_UNKNOWN',
      reasons: [String(outcome.reason ?? 'observer_unavailable')],
    };
  })();
}

export function reconcilePaymentOperation(
  db: Database.Database,
  chain: ChainClient,
  suppliedOperation: OperationRow,
  requiredConfirmations: number,
  signingSecret: string,
  now = new Date(),
): Promise<ReconcileResult> {
  const existing = paymentReconciliationsInFlight.get(suppliedOperation.id);
  if (existing) return existing;

  let task!: Promise<ReconcileResult>;
  task = reconcilePaymentOperationOnce(
    db,
    chain,
    suppliedOperation,
    requiredConfirmations,
    signingSecret,
    now,
  ).finally(() => {
    if (paymentReconciliationsInFlight.get(suppliedOperation.id) === task) {
      paymentReconciliationsInFlight.delete(suppliedOperation.id);
    }
  });
  paymentReconciliationsInFlight.set(suppliedOperation.id, task);
  return task;
}

async function reconcilePaymentOperationOnce(
  db: Database.Database,
  chain: ChainClient,
  suppliedOperation: OperationRow,
  requiredConfirmations: number,
  signingSecret: string,
  now = new Date(),
): Promise<ReconcileResult> {
  const order = getOrderById(db, suppliedOperation.order_id);
  const operation = getOperationById(db, suppliedOperation.id);
  if (!order || !operation || !operation.tx_hash) {
    return {
      orderId: suppliedOperation.order_id,
      operationId: suppliedOperation.id,
      state: 'REJECTED',
      reasons: ['missing_order_operation_or_hash'],
    };
  }
  const integrity = verifyOrderIntegrity(order, signingSecret);
  if (!integrity.ok) {
    return db.transaction(() => markIntegrityFailure(db, order, operation, integrity.reasons, now.toISOString()))();
  }
  if (isImmutableOrder(order)) {
    if (operation.type === 'PAYMENT_ATTEMPT' && isActiveOperation(operation)) {
      db.prepare(`
        UPDATE operations SET state = 'CONFIRMED_NOT_APPLIED', retry_fenced = 1,
          outcome_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify({ reason: 'order_already_terminal' }), now.toISOString(), operation.id);
    }
    return currentResult(order, getOperationById(db, operation.id) ?? operation);
  }
  if (!isActiveOperation(operation)) return currentResult(order, operation);

  const observedAt = now.toISOString();
  const claimed = db.prepare(`
    UPDATE operations
    SET state = 'RUNNING', retry_fenced = 1, attempt_count = attempt_count + 1, updated_at = ?
    WHERE id = ? AND state IN ('REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN')
  `).run(observedAt, operation.id);
  if (claimed.changes === 0) {
    return currentResult(getOrderById(db, order.id) ?? order, getOperationById(db, operation.id) ?? operation);
  }

  let observation: ChainObservation;
  try {
    observation = await chain.observeTransaction(operation.tx_hash);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown_observer_error';
    return applyUnknownOutcome(db, order.id, operation.id, observedAt, {
      reason: 'observer_unavailable',
      error: message,
    }, signingSecret);
  }

  if (!observation.transaction) {
    return applyUnknownOutcome(db, order.id, operation.id, observedAt, {
      reason: 'transaction_not_found',
      headBlock: observation.headBlock,
    }, signingSecret);
  }

  const transaction = observation.transaction;
  const terms = integrity.terms!;
  const match = matchPayment(terms, transaction);
  const reasons = [...match.reasons];
  if (transaction.hash.toLowerCase() !== operation.tx_hash.toLowerCase()) reasons.push('wrong_transaction_hash');
  if (transactionTimeMs(transaction.timestamp) > Date.parse(terms.expiresAt)) reasons.push('late_payment');
  const matchState = reasons.length > 0
    ? 'CONFLICT'
    : observation.confirmations < requiredConfirmations
      ? 'FINALITY_PENDING'
      : 'MATCHED_FINAL';

  return db.transaction(() => {
    const currentOrder = getOrderById(db, order.id);
    const currentOperation = getOperationById(db, operation.id);
    if (!currentOrder || !currentOperation) {
      return { orderId: order.id, operationId: operation.id, state: 'REJECTED', reasons: ['missing_order_or_operation'] };
    }
    const currentIntegrity = verifyOrderIntegrity(currentOrder, signingSecret);
    if (!currentIntegrity.ok) {
      return markIntegrityFailure(db, currentOrder, currentOperation, currentIntegrity.reasons, observedAt);
    }
    // A response that started earlier must never regress a completed or conflicted order.
    if (isImmutableOrder(currentOrder)) return currentResult(currentOrder, currentOperation);
    if (!isActiveOperation(currentOperation)) return currentResult(currentOrder, currentOperation);

    insertObservation(db, currentOrder, currentOperation, observation, matchState, reasons, observedAt);

    if (currentOperation.type === 'PAYMENT_ATTEMPT') {
      if (reasons.length > 0) {
        db.prepare(`
          UPDATE operations SET state = 'REJECTED', retry_fenced = 1, outcome_json = ?, updated_at = ?
          WHERE id = ? AND state IN ('REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN')
        `).run(JSON.stringify({ reasons, observation }), observedAt, currentOperation.id);
        db.prepare(`
          INSERT INTO audit_events(id, order_id, actor, action, data_json, created_at)
          VALUES (?, ?, 'observer', 'payment_attempt_rejected', ?, ?)
        `).run(randomUUID(), currentOrder.id, JSON.stringify({ reasons, txHash: currentOperation.tx_hash }), observedAt);
        return {
          orderId: currentOrder.id,
          operationId: currentOperation.id,
          state: 'PAYMENT_ATTEMPT_REJECTED',
          reasons,
        };
      }

      const existingAuthority = db.prepare(`
        SELECT * FROM operations WHERE order_id = ? AND type = 'PAYMENT_OBSERVATION' LIMIT 1
      `).get(currentOrder.id) as OperationRow | undefined;
      if (existingAuthority) {
        db.prepare(`
          UPDATE operations SET state = 'CONFIRMED_NOT_APPLIED', retry_fenced = 1,
            outcome_json = ?, updated_at = ? WHERE id = ?
        `).run(JSON.stringify({
          reason: 'canonical_payment_already_exists',
          canonicalTxHash: existingAuthority.tx_hash,
        }), observedAt, currentOperation.id);
        db.prepare(`
          INSERT INTO audit_events(id, order_id, actor, action, data_json, created_at)
          VALUES (?, ?, 'observer', 'additional_exact_payment_observed', ?, ?)
        `).run(randomUUID(), currentOrder.id, JSON.stringify({
          txHash: currentOperation.tx_hash,
          canonicalTxHash: existingAuthority.tx_hash,
        }), observedAt);
        return currentResult(currentOrder, existingAuthority, ['canonical_payment_already_exists']);
      }

      const authorityId = randomUUID();
      db.prepare(`
        INSERT INTO operations(
          id, order_id, type, semantic_key, state, tx_hash, retry_fenced,
          outcome_json, attempt_count, created_at, updated_at
        ) VALUES (?, ?, 'PAYMENT_OBSERVATION', ?, 'RUNNING', ?, 1, ?, 1, ?, ?)
      `).run(
        authorityId, currentOrder.id, `pay-authority:${currentOrder.id}`,
        currentOperation.tx_hash,
        JSON.stringify({ promotedFromAttempt: currentOperation.id, confirmations: observation.confirmations }),
        observedAt, observedAt,
      );
      db.prepare(`
        UPDATE operations SET state = 'CONFIRMED_APPLIED', retry_fenced = 0,
          outcome_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify({ promotedToAuthority: authorityId }), observedAt, currentOperation.id);
      closeUnverifiedAttempts(db, currentOrder.id, observedAt, 'exact_payment_authority_claimed');

      if (observation.confirmations < requiredConfirmations) {
        const advanced = db.prepare(`
          UPDATE orders SET state = 'FINALITY_PENDING', payment_tx_hash = ?, payment_from = ?,
            payment_confirmations = ?, last_observed_at = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND version = ? AND payment_tx_hash IS NULL
            AND state NOT IN ('FULFILLED', 'REFUNDED', 'CONFLICT')
        `).run(
          currentOperation.tx_hash, transaction.from, observation.confirmations,
          observedAt, observedAt, currentOrder.id, currentOrder.version,
        );
        if (advanced.changes !== 1) throw new Error('PAYMENT_AUTHORITY_CLAIM_FAILED');
        db.prepare(`
          INSERT INTO audit_events(id, order_id, actor, action, data_json, created_at)
          VALUES (?, ?, 'observer', 'exact_payment_promoted_to_authority', ?, ?)
        `).run(randomUUID(), currentOrder.id, JSON.stringify({
          txHash: currentOperation.tx_hash,
          confirmations: observation.confirmations,
          authorityId,
        }), observedAt);
        return { orderId: currentOrder.id, operationId: authorityId, state: 'FINALITY_PENDING', reasons: [] };
      }

      const fulfilled = db.prepare(`
        UPDATE orders SET state = 'FULFILLED', payment_tx_hash = ?, payment_from = ?,
          payment_confirmations = ?, conflict_reasons = '[]', last_observed_at = ?,
          updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND payment_tx_hash IS NULL
          AND state NOT IN ('FULFILLED', 'REFUNDED', 'CONFLICT')
      `).run(
        currentOperation.tx_hash, transaction.from, observation.confirmations,
        observedAt, observedAt, currentOrder.id, currentOrder.version,
      );
      if (fulfilled.changes !== 1) throw new Error('PAYMENT_AUTHORITY_CLAIM_FAILED');
      db.prepare(`
        INSERT INTO fulfilments(id, order_id, semantic_key, reference, message, state, released_at)
        VALUES (?, ?, ?, ?, ?, 'RELEASED', ?)
      `).run(
        randomUUID(), currentOrder.id, `fulfil:${currentOrder.id}:${currentOrder.revision}`,
        currentOrder.fulfilment_reference, currentOrder.fulfilment_message, observedAt,
      );
      db.prepare(`
        UPDATE operations SET state = 'CONFIRMED_APPLIED', retry_fenced = 0,
          outcome_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify({ confirmations: observation.confirmations }), observedAt, authorityId);
      db.prepare(`
        INSERT INTO audit_events(id, order_id, actor, action, data_json, created_at)
        VALUES (?, ?, 'observer', 'payment_finalized_and_fulfilment_released', ?, ?)
      `).run(randomUUID(), currentOrder.id, JSON.stringify({
        txHash: currentOperation.tx_hash,
        confirmations: observation.confirmations,
        authorityId,
      }), observedAt);
      return { orderId: currentOrder.id, operationId: authorityId, state: 'FULFILLED', reasons: [] };
    }

    if (reasons.length > 0) {
      const updated = db.prepare(`
        UPDATE orders SET state = 'CONFLICT', conflict_reasons = ?, payment_from = ?,
          payment_confirmations = ?, last_observed_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND state NOT IN ('FULFILLED', 'REFUNDED', 'CONFLICT')
      `).run(
        JSON.stringify(reasons), transaction.from, observation.confirmations,
        observedAt, observedAt, currentOrder.id, currentOrder.version,
      );
      if (updated.changes === 0) {
        return currentResult(getOrderById(db, currentOrder.id) ?? currentOrder, currentOperation);
      }
      db.prepare(`
        UPDATE operations SET state = 'CONFLICT', outcome_json = ?, updated_at = ?
        WHERE id = ? AND state IN ('REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN')
      `).run(JSON.stringify({ reasons, observation }), observedAt, currentOperation.id);
      closeUnverifiedAttempts(db, currentOrder.id, observedAt, 'canonical_payment_conflict');
      db.prepare(`
        INSERT INTO audit_events(id, order_id, actor, action, data_json, created_at)
        VALUES (?, ?, 'observer', 'payment_conflict', ?, ?)
      `).run(randomUUID(), currentOrder.id, JSON.stringify({ reasons, txHash: operation.tx_hash }), observedAt);
      return { orderId: currentOrder.id, operationId: currentOperation.id, state: 'CONFLICT', reasons };
    }

    closeUnverifiedAttempts(db, currentOrder.id, observedAt, 'canonical_payment_authority_active');

    if (observation.confirmations < requiredConfirmations) {
      const updated = db.prepare(`
        UPDATE orders SET state = 'FINALITY_PENDING', payment_from = ?, payment_confirmations = ?,
          last_observed_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND version = ? AND state NOT IN ('FULFILLED', 'REFUNDED', 'CONFLICT')
      `).run(
        transaction.from, observation.confirmations, observedAt, observedAt,
        currentOrder.id, currentOrder.version,
      );
      if (updated.changes === 0) {
        return currentResult(getOrderById(db, currentOrder.id) ?? currentOrder, currentOperation);
      }
      db.prepare(`
        UPDATE operations SET state = 'RUNNING', outcome_json = ?, updated_at = ?
        WHERE id = ? AND state IN ('REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN')
      `).run(JSON.stringify({ confirmations: observation.confirmations }), observedAt, currentOperation.id);
      return { orderId: currentOrder.id, operationId: currentOperation.id, state: 'FINALITY_PENDING', reasons: [] };
    }

    const updated = db.prepare(`
      UPDATE orders SET state = 'FULFILLED', payment_from = ?, payment_confirmations = ?,
        conflict_reasons = '[]', last_observed_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ? AND state NOT IN ('FULFILLED', 'REFUNDED', 'CONFLICT')
    `).run(
      transaction.from, observation.confirmations, observedAt, observedAt,
      currentOrder.id, currentOrder.version,
    );
    if (updated.changes === 0) {
      return currentResult(getOrderById(db, currentOrder.id) ?? currentOrder, currentOperation);
    }
    db.prepare(`
      INSERT OR IGNORE INTO fulfilments(
        id, order_id, semantic_key, reference, message, state, released_at
      ) VALUES (?, ?, ?, ?, ?, 'RELEASED', ?)
    `).run(
      randomUUID(), currentOrder.id, `fulfil:${currentOrder.id}:${currentOrder.revision}`,
      currentOrder.fulfilment_reference, currentOrder.fulfilment_message, observedAt,
    );
    db.prepare(`
      UPDATE operations SET state = 'CONFIRMED_APPLIED', retry_fenced = 0,
        outcome_json = ?, updated_at = ?
      WHERE id = ? AND state IN ('REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN')
    `).run(JSON.stringify({ confirmations: observation.confirmations }), observedAt, currentOperation.id);
    db.prepare(`
      INSERT INTO audit_events(id, order_id, actor, action, data_json, created_at)
      VALUES (?, ?, 'observer', 'payment_finalized_and_fulfilment_released', ?, ?)
    `).run(
      randomUUID(), currentOrder.id,
      JSON.stringify({ txHash: operation.tx_hash, confirmations: observation.confirmations }), observedAt,
    );
    return { orderId: currentOrder.id, operationId: currentOperation.id, state: 'FULFILLED', reasons: [] };
  })();
}

export async function reconcileAllPayments(
  db: Database.Database,
  chain: ChainClient,
  requiredConfirmations: number,
  signingSecret: string,
): Promise<ReconcileResult[]> {
  const operations = listPaymentOperationsForReconciliation(db);
  const results: ReconcileResult[] = [];
  for (const operation of operations) {
    results.push(await reconcilePaymentOperation(db, chain, operation, requiredConfirmations, signingSecret));
  }
  return results;
}
