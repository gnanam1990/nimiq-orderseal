import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ObservedTransaction } from '../shared/domain.js';

const transactionSchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/i),
  blockNumber: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  confirmations: z.number().int().nonnegative(),
  from: z.string().min(1),
  to: z.string().min(1),
  value: z.number().int().nonnegative(),
  recipientData: z.string(),
  networkId: z.number().int(),
  executionResult: z.boolean(),
});

const rpcEnvelopeSchema = z.object({
  result: z.object({ data: z.unknown() }).optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
});

export interface ChainObservation {
  transaction: ObservedTransaction | null;
  headBlock: number;
  confirmations: number;
  source: string;
}

export interface ChainClient {
  observeTransaction(hash: string): Promise<ChainObservation>;
}

export class ChainUnavailableError extends Error {
  override name = 'ChainUnavailableError';
}

export class RpcChainClient implements ChainClient {
  constructor(
    private readonly rpcUrl: string,
    private readonly timeoutMs = 8_000,
  ) {}

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: randomUUID() }),
        signal: controller.signal,
      });
      if (!response.ok) throw new ChainUnavailableError(`RPC HTTP ${response.status}`);
      const envelope = rpcEnvelopeSchema.safeParse(await response.json());
      if (!envelope.success) throw new ChainUnavailableError('RPC returned an invalid envelope.');
      if (envelope.data.error) {
        throw new ChainUnavailableError(`RPC ${envelope.data.error.code}: ${envelope.data.error.message}`);
      }
      if (!envelope.data.result) throw new ChainUnavailableError('RPC response has no result.');
      return envelope.data.result.data;
    } catch (error) {
      if (error instanceof ChainUnavailableError) throw error;
      const message = error instanceof Error ? error.message : 'Unknown RPC error';
      throw new ChainUnavailableError(message);
    } finally {
      clearTimeout(timeout);
    }
  }

  async observeTransaction(hash: string): Promise<ChainObservation> {
    const [rawTransaction, rawHead] = await Promise.all([
      this.call('getTransactionByHash', [hash]),
      this.call('getBlockNumber', []),
    ]);
    const headBlock = z.number().int().nonnegative().parse(rawHead);
    if (rawTransaction === null) {
      return { transaction: null, headBlock, confirmations: 0, source: this.rpcUrl };
    }
    const transaction = transactionSchema.parse(rawTransaction);
    const derivedConfirmations = Math.max(0, headBlock - transaction.blockNumber + 1);
    return {
      transaction,
      headBlock,
      confirmations: Math.min(transaction.confirmations, derivedConfirmations),
      source: this.rpcUrl,
    };
  }
}
