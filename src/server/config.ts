import { z } from 'zod';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  dbPath: string;
  adminToken: string;
  signingSecret: string;
  rpcUrl: string;
  requiredConfirmations: number;
  publicOrigin: string;
  observerIntervalMs: number;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ORDERSEAL_DB_PATH: z.string().min(1).default('./data/orderseal.db'),
  ORDERSEAL_ADMIN_TOKEN: z.string().min(24),
  ORDERSEAL_SIGNING_SECRET: z.string().min(32),
  NIMIQ_RPC_URL: z.string().url().startsWith('https://').default('https://rpc.nimiqwatch.com'),
  NIMIQ_REQUIRED_CONFIRMATIONS: z.coerce.number().int().min(2).max(120).default(10),
  ORDERSEAL_PUBLIC_ORIGIN: z.string().url().default('http://localhost:5173'),
  ORDERSEAL_OBSERVER_INTERVAL_MS: z.coerce.number().int().min(2_000).max(120_000).default(7_000),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid OrderSeal configuration:\n${fields.join('\n')}`);
  }
  return {
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    dbPath: parsed.data.ORDERSEAL_DB_PATH,
    adminToken: parsed.data.ORDERSEAL_ADMIN_TOKEN,
    signingSecret: parsed.data.ORDERSEAL_SIGNING_SECRET,
    rpcUrl: parsed.data.NIMIQ_RPC_URL,
    requiredConfirmations: parsed.data.NIMIQ_REQUIRED_CONFIRMATIONS,
    publicOrigin: parsed.data.ORDERSEAL_PUBLIC_ORIGIN.replace(/\/$/, ''),
    observerIntervalMs: parsed.data.ORDERSEAL_OBSERVER_INTERVAL_MS,
  };
}
