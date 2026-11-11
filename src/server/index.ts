import { buildApp } from './app.js';
import { RpcChainClient } from './chain.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { reconcileAllPayments } from './reconcile.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
const chain = new RpcChainClient(config.rpcUrl);
const app = await buildApp({ config, db, chain });

const observer = setInterval(() => {
  void reconcileAllPayments(db, chain, config.requiredConfirmations, config.signingSecret)
    .then((results) => {
      if (results.length > 0) app.log.info({ results }, 'Observer reconciliation completed.');
    })
    .catch((error) => app.log.error({ error }, 'Observer reconciliation failed.'));
}, config.observerIntervalMs);
observer.unref();

const close = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down OrderSeal.');
  clearInterval(observer);
  await app.close();
  db.close();
  process.exit(0);
};

process.on('SIGTERM', () => void close('SIGTERM'));
process.on('SIGINT', () => void close('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });
