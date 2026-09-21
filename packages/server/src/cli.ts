#!/usr/bin/env node
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createServer } from './app.js';
import { saasFromEnv } from './config.js';

const adminToken = process.env.PQ_ADMIN_TOKEN;
if (!adminToken) {
  console.error('Set PQ_ADMIN_TOKEN to a random secret (32+ characters). Generate one with: openssl rand -hex 32');
  process.exit(1);
}
const webRoot = resolve(process.env.PQ_WEB_ROOT ?? 'dist/web');
const saas = saasFromEnv(process.env);
const { app } = await createServer({
  ...(saas ? { saas } : {}),
  database: process.env.PQ_DATABASE ?? '.data/queue.sqlite', adminToken,
  origins: (process.env.PQ_ORIGINS ?? '').split(',').filter(Boolean),
  trustProxy: (process.env.PQ_TRUST_PROXY ?? '').split(',').filter(Boolean),
  ...(existsSync(webRoot) ? { webRoot } : {}),
});
const address = await app.listen({ host: process.env.PQ_HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 8787) });
console.log(`Public Queue listening at ${address}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
