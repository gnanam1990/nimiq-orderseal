import { expect, it } from 'vitest';
import { RpcChainClient } from './chain.js';

const live = process.env.RUN_LIVE_RPC === '1' ? it : it.skip;

live('matches the current public mainnet RPC transaction contract', async () => {
  const hash = 'dbdd9af5d053d7e4dafddbc1c2f3767d021401a4210a8ec75cda819d86e97a30';
  const observation = await new RpcChainClient('https://rpc.nimiqwatch.com', 12_000)
    .observeTransaction(hash);
  expect(observation.transaction).not.toBeNull();
  expect(observation.transaction).toMatchObject({ hash, networkId: 24, executionResult: true });
  expect(observation.headBlock).toBeGreaterThanOrEqual(observation.transaction!.blockNumber);
  expect(observation.confirmations).toBeGreaterThan(0);
  expect(observation.source).toBe('https://rpc.nimiqwatch.com');
}, 15_000);
