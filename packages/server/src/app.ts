import Fastify, { type FastifyRequest } from 'fastify';
import { registerSaas, type SaasOptions } from './saas.js';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import serveStatic from '@fastify/static';
import { timingSafeEqual, createHash } from 'node:crypto';
import { z } from 'zod';
import { payloadSchema, submitSchema } from '../../protocol/src/index.js';
import { importPublicKey } from '../../protocol/src/crypto.js';
import { Fault, Store } from './store.js';

export interface ServerOptions {
  saas?: SaasOptions;
  database: string; adminToken: string; origins?: string[]; webRoot?: string;
  trustProxy?: string[]; leaseMs?: number; dailyLimit?: number; pendingLimit?: number;
}
function bearer(header: string | undefined): string {
  if (!header?.startsWith('Bearer ') || header.length > 200) throw new Fault('unauthorized', 401);
  return header.slice(7);
}
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const nameSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const idSchema = z.object({ id: z.uuid() });
export async function createServer(options: ServerOptions) {
  if (options.adminToken.length < 32) throw new Error('PQ_ADMIN_TOKEN must contain at least 32 characters');
  const store = new Store(options.database, {
    ownerEmails: options.saas?.ownerEmails ?? [],
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
    ...(options.dailyLimit === undefined ? {} : { dailyLimit: options.dailyLimit }),
    ...(options.pendingLimit === undefined ? {} : { pendingLimit: options.pendingLimit }),
  });
  const app = Fastify({ logger: false, bodyLimit: 1_500_000, requestTimeout: 30_000, connectionTimeout: 35_000, trustProxy: options.trustProxy ?? false });
  await app.register(cors, {
    origin: options.origins?.includes('*') ? true : options.origins ?? [],
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Authorization', 'Content-Type'], credentials: false,
  });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self' https://check.grokked.it/js/script.js; style-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof Fault) return reply.code(error.status).send({ error: error.code });
    if (error instanceof z.core.$ZodError) return reply.code(400).send({ error: 'invalid_request' });
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 500;
    // Never log request bodies, provider responses, credentials or validation input.
    return reply.code(status >= 400 && status <= 599 ? status : 500).send({ error: status === 413 ? 'payload_too_large' : status === 429 ? 'rate_limited' : 'internal_error' });
  });
  const maintenance = setInterval(() => store.sweep(), 30_000); maintenance.unref();
  app.addHook('onClose', async () => { clearInterval(maintenance); store.close(); });
  const saas = options.saas ? await registerSaas(app, store, options.saas) : undefined;
  function owner(request: FastifyRequest) {
    if (request.headers.authorization) return store.owner(bearer(request.headers.authorization));
    if (!saas) throw new Fault('unauthorized', 401);
    return store.project(saas.account(request).project_id);
  }
  app.get('/health', async () => ({ ok: true, version: '0.1.0' }));
  app.post('/v1/projects', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (!timingSafeEqual(digest(bearer(request.headers.authorization)), digest(options.adminToken))) throw new Fault('unauthorized', 401);
    const body = nameSchema.extend({ requireEncryption: z.boolean().default(true) }).parse(request.body);
    return reply.code(201).send(store.createProject(body.name, body.requireEncryption));
  });
  app.get('/v1/project', async request => {
    const project = owner(request);
    return { id: project.id, name: project.name, requireEncryption: Boolean(project.require_encryption), devices: store.devices(project.id), clients: store.clients(project.id) };
  });
  app.post('/v1/devices', async (request, reply) => {
    const project = owner(request);
    const body = nameSchema.parse(request.body);
    return reply.code(201).send(store.createDevice(project.id, body.name));
  });
  app.delete('/v1/devices/:id', async request => {
    const project = owner(request);
    store.revoke(project.id, idSchema.parse(request.params).id, 'device'); return { ok: true };
  });
  app.post('/v1/clients', async (request, reply) => {
    const project = owner(request);
    const body = nameSchema.extend({ deviceId: z.uuid() }).parse(request.body);
    return reply.code(201).send(store.createClient(project.id, body.deviceId, body.name));
  });
  app.delete('/v1/clients/:id', async request => {
    const project = owner(request);
    store.revoke(project.id, idSchema.parse(request.params).id, 'client'); return { ok: true };
  });
  app.post('/v1/pair', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async request => {
    const body = z.object({ code: z.string().min(40).max(100), publicKey: z.string().min(80).max(100) }).strict().parse(request.body);
    try { await importPublicKey(body.publicKey); } catch { throw new Fault('invalid_public_key'); }
    return store.pair(body.code, body.publicKey);
  });
  app.post('/v1/jobs', async (request, reply) => {
    const client = store.client(bearer(request.headers.authorization));
    return reply.code(202).send(store.submit(client.id, submitSchema.parse(request.body)));
  });
  app.get('/v1/jobs', async request => store.jobs(store.client(bearer(request.headers.authorization)).id));
  app.get('/v1/jobs/:id', async request => store.getJob(store.client(bearer(request.headers.authorization)).id, idSchema.parse(request.params).id));
  app.get('/v1/jobs/:id/events', async request => {
    const client = store.client(bearer(request.headers.authorization));
    const query = z.object({ attemptId: z.uuid().optional(), after: z.coerce.number().int().min(0).max(2048).default(0) }).strict().parse(request.query);
    return store.events(client.id, idSchema.parse(request.params).id, query.attemptId ?? null, query.after);
  });
  app.post('/v1/agent/jobs/:id/blocks', async request => {
    const agent = store.agent(bearer(request.headers.authorization));
    const body = z.object({ attemptId: z.uuid(), sequence: z.number().int().min(1).max(2048), payload: payloadSchema }).strict().parse(request.body);
    store.append(agent.id, idSchema.parse(request.params).id, body.attemptId, body.sequence, body.payload); return { ok: true };
  });
  app.delete('/v1/jobs/:id', async request => store.cancel(store.client(bearer(request.headers.authorization)).id, idSchema.parse(request.params).id));
  app.get('/v1/agent/queue', async request => store.agentQueue(store.agent(bearer(request.headers.authorization)).id));
  app.post('/v1/agent/claim', async request => {
    const agent = store.agent(bearer(request.headers.authorization));
    return { job: store.claim(agent.id) };
  });
  app.post('/v1/agent/jobs/:id/heartbeat', async request => {
    const agent = store.agent(bearer(request.headers.authorization));
    const body = z.object({ attemptId: z.uuid() }).strict().parse(request.body);
    store.heartbeat(agent.id, idSchema.parse(request.params).id, body.attemptId); return { ok: true };
  });
  app.post('/v1/agent/jobs/:id/finish', async request => {
    const agent = store.agent(bearer(request.headers.authorization));
    const body = z.object({ attemptId: z.uuid(), result: payloadSchema, success: z.boolean() }).strict().parse(request.body);
    store.finish(agent.id, idSchema.parse(request.params).id, body.attemptId, body.result, body.success); return { ok: true };
  });
  if (options.webRoot) await app.register(serveStatic, { root: options.webRoot, index: 'index.html' });
  await app.ready();
  return { app, store };
}
