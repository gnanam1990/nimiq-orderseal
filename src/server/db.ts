import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OrderState, SignedOrderTerms } from '../shared/domain.js';

export interface OrderRow {
  id: string;
  code: string;
  public_token: string;
  revision: number;
  item_name: string;
  description: string;
  recipient: string;
  amount_luna: number;
  asset: 'NIM';
  network: 'mainnet';
  expires_at: string;
  fulfilment_reference: string;
  fulfilment_message: string;
  memo: string;
  terms_json: string;
  signature: string;
  state: OrderState;
  version: number;
  payment_tx_hash: string | null;
  payment_from: string | null;
  payment_confirmations: number | null;
  conflict_reasons: string;
  last_observed_at: string | null;
  refund_finalized_luna: number;
  created_at: string;
  updated_at: string;
}

export interface OperationRow {
  id: string;
  order_id: string;
  type: 'PAYMENT_ATTEMPT' | 'PAYMENT_OBSERVATION' | 'FULFILMENT_DISPATCH' | 'REFUND_OBSERVATION';
  semantic_key: string;
  state:
    | 'REQUESTED'
    | 'RUNNING'
    | 'OUTCOME_UNKNOWN'
    | 'CONFIRMED_APPLIED'
    | 'CONFIRMED_NOT_APPLIED'
    | 'REJECTED'
    | 'CONFLICT';
  tx_hash: string | null;
  retry_fenced: number;
  outcome_json: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
}

export interface MerchantConfigRow {
  recipient: string;
  network: 'mainnet';
  revision: number;
  verified_at: string;
}

export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS merchant_configs (
      revision INTEGER PRIMARY KEY,
      recipient TEXT NOT NULL,
      network TEXT NOT NULL CHECK (network = 'mainnet'),
      verified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS merchant_configs_one_active
      ON merchant_configs(active) WHERE active = 1;

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      public_token TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      item_name TEXT NOT NULL,
      description TEXT NOT NULL,
      recipient TEXT NOT NULL,
      amount_luna INTEGER NOT NULL CHECK (amount_luna > 0),
      asset TEXT NOT NULL CHECK (asset = 'NIM'),
      network TEXT NOT NULL CHECK (network = 'mainnet'),
      expires_at TEXT NOT NULL,
      fulfilment_reference TEXT NOT NULL,
      fulfilment_message TEXT NOT NULL,
      memo TEXT NOT NULL,
      terms_json TEXT NOT NULL,
      signature TEXT NOT NULL,
      state TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      payment_tx_hash TEXT UNIQUE,
      payment_from TEXT,
      payment_confirmations INTEGER,
      conflict_reasons TEXT NOT NULL DEFAULT '[]',
      last_observed_at TEXT,
      refund_finalized_luna INTEGER NOT NULL DEFAULT 0 CHECK (refund_finalized_luna >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS orders_state_idx ON orders(state, updated_at);

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      semantic_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      tx_hash TEXT,
      retry_fenced INTEGER NOT NULL DEFAULT 0 CHECK (retry_fenced IN (0, 1)),
      outcome_json TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS operations_reconcile_idx
      ON operations(type, state, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS operations_one_payment_authority
      ON operations(order_id) WHERE type = 'PAYMENT_OBSERVATION';
    CREATE UNIQUE INDEX IF NOT EXISTS operations_one_attempt_per_hash
      ON operations(order_id, tx_hash) WHERE type = 'PAYMENT_ATTEMPT';

    CREATE TABLE IF NOT EXISTS operation_aliases (
      semantic_key TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      tx_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      tx_hash TEXT NOT NULL,
      source TEXT NOT NULL,
      raw_digest TEXT NOT NULL,
      block_number INTEGER,
      confirmations INTEGER,
      execution_result INTEGER,
      from_address TEXT,
      to_address TEXT,
      value_luna INTEGER,
      recipient_data TEXT,
      match_state TEXT NOT NULL,
      mismatch_reasons TEXT NOT NULL DEFAULT '[]',
      observed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS observations_order_idx ON observations(order_id, observed_at);

    CREATE TABLE IF NOT EXISTS fulfilments (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      semantic_key TEXT NOT NULL UNIQUE,
      reference TEXT NOT NULL,
      message TEXT NOT NULL,
      state TEXT NOT NULL,
      released_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
      tx_hash TEXT NOT NULL UNIQUE,
      amount_luna INTEGER NOT NULL CHECK (amount_luna > 0),
      state TEXT NOT NULL,
      finalized_at TEXT
    );

    CREATE TABLE IF NOT EXISTS idempotency_responses (
      key TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.prepare('INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)')
    .run(1, new Date().toISOString());
}

export function getActiveMerchantConfig(db: Database.Database): MerchantConfigRow | null {
  return (db.prepare(
    'SELECT recipient, network, revision, verified_at FROM merchant_configs WHERE active = 1',
  ).get() as MerchantConfigRow | undefined) ?? null;
}

export function getOrderById(db: Database.Database, id: string): OrderRow | null {
  return (db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined) ?? null;
}

export function getOrderByPublicToken(db: Database.Database, token: string): OrderRow | null {
  return (db.prepare('SELECT * FROM orders WHERE public_token = ?').get(token) as OrderRow | undefined) ?? null;
}

export function listOrders(db: Database.Database, limit = 100): OrderRow[] {
  return db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit) as OrderRow[];
}

export function getTerms(row: OrderRow): SignedOrderTerms {
  return JSON.parse(row.terms_json) as SignedOrderTerms;
}

export function getPaymentOperation(db: Database.Database, orderId: string): OperationRow | null {
  return (db.prepare(
    "SELECT * FROM operations WHERE order_id = ? AND type = 'PAYMENT_OBSERVATION' ORDER BY created_at DESC LIMIT 1",
  ).get(orderId) as OperationRow | undefined) ?? null;
}

export function getPaymentAttemptByHash(db: Database.Database, orderId: string, txHash: string): OperationRow | null {
  return (db.prepare(
    "SELECT * FROM operations WHERE order_id = ? AND type = 'PAYMENT_ATTEMPT' AND lower(tx_hash) = lower(?) LIMIT 1",
  ).get(orderId, txHash) as OperationRow | undefined) ?? null;
}

export function getOperationById(db: Database.Database, id: string): OperationRow | null {
  return (db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as OperationRow | undefined) ?? null;
}

export function getOperationBySemanticKey(db: Database.Database, key: string): OperationRow | null {
  const direct = db.prepare('SELECT * FROM operations WHERE semantic_key = ?').get(key) as OperationRow | undefined;
  if (direct) return direct;
  return (db.prepare(`
    SELECT operations.* FROM operation_aliases
    JOIN operations ON operations.id = operation_aliases.operation_id
    WHERE operation_aliases.semantic_key = ?
  `).get(key) as OperationRow | undefined) ?? null;
}

export function bindOperationAlias(
  db: Database.Database,
  semanticKey: string,
  operation: OperationRow,
  createdAt: string,
): void {
  if (operation.semantic_key === semanticKey) return;
  db.prepare(`
    INSERT INTO operation_aliases(semantic_key, operation_id, tx_hash, created_at)
    VALUES (?, ?, ?, ?)
  `).run(semanticKey, operation.id, operation.tx_hash, createdAt);
}

export function listPaymentOperationsForReconciliation(db: Database.Database): OperationRow[] {
  return db.prepare(`
    SELECT * FROM operations
    WHERE type = 'PAYMENT_OBSERVATION'
      AND state IN ('REQUESTED', 'RUNNING', 'OUTCOME_UNKNOWN')
    ORDER BY updated_at ASC
    LIMIT 100
  `).all() as OperationRow[];
}

export function getFulfilment(db: Database.Database, orderId: string): {
  state: string;
  released_at: string;
} | null {
  return (db.prepare(
    'SELECT state, released_at FROM fulfilments WHERE order_id = ?',
  ).get(orderId) as { state: string; released_at: string } | undefined) ?? null;
}
