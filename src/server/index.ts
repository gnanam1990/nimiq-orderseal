import { buildApp } from './app.js';
import { RpcChainClient } from './chain.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { startObserverLoop } from './observer.js';
import { reconcileAllPayments } from './reconcile.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const chain = new RpcChainClient(config.rpcUrl);
const app = await buildApp({ config, db, chain });

const observer = startObserverLoop({
  intervalMs: config.observerIntervalMs,
  run: () => reconcileAllPayments(db, chain, config.requiredConfirmations, config.signingSecret),
  onSuccess: (results) => {
    if (results.length > 0) app.log.info({ results }, 'Observer reconciliation completed.');
  },
  onError: (error) => app.log.error({ error }, 'Observer reconciliation failed.'),
});

const close = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down OrderSeal.');
  await observer.stop();
  await app.close();
  db.close();
  process.exit(0);
};

process.on('SIGTERM', () => void close('SIGTERM'));
process.on('SIGINT', () => void close('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });
