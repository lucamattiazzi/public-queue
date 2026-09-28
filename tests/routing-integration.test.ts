import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createServer } from '../packages/server/src/app.js';
import { generateIdentity } from '../packages/protocol/src/crypto.js';
import { PublicQueue, MemoryIdentityStore } from '../packages/sdk/src/index.js';
import { runWorker } from '../packages/agent/src/worker.js';
import { routingSchema } from '../packages/agent/src/routing.js';

test('encrypted profiles route to the intended provider, reload between jobs, and never fall back', { timeout: 20000 }, async () => {
  const { app, store } = await createServer({ database: ':memory:', adminToken: 'test'.repeat(12) });
  const local = Fastify(), cloud = Fastify();
  const requests: { provider: string; model: string; key: string | undefined }[] = [];
  for (const [name, runtime] of [['local', local], ['cloud', cloud]] as const) runtime.post('/v1/chat/completions', async (request, reply) => {
    const body = request.body as { model: string; stream?: boolean };
    requests.push({ provider: name, model: body.model, key: request.headers.authorization });
    if (body.model === 'broken') return reply.code(503).send({ error: 'private provider error' });
    if (body.stream) return reply.type('text/event-stream').send('data: {"choices":[{"delta":{"content":"streamed"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    return { choices: [{ message: { content: name }, finish_reason: 'stop' }] };
  });
  const server = await app.listen({ host: '127.0.0.1', port: 0 });
  const localUrl = `${await local.listen({ host: '127.0.0.1', port: 0 })}/v1`;
  const cloudUrl = `${await cloud.listen({ host: '127.0.0.1', port: 0 })}/v1`;
  const project = store.createProject('Routing'), device = store.createDevice(project.id, 'Mac');
  const identity = await generateIdentity();
  const paired = store.pair(device.pairingCode, identity.publicKey), client = store.createClient(project.id, device.id, 'Test');
  const sdk = new PublicQueue({ server, token: client.token, deviceId: device.id, publicKey: identity.publicKey, identityStore: new MemoryIdentityStore(), pollMs: 20 });
  let routing = routingSchema.parse({ destinations: [
    { id: 'local', name: 'Local', kind: 'local', model: 'small', runtimeUrl: localUrl, runtimeKey: 'LOCAL' },
    { id: 'cloud', name: 'Cloud', kind: 'cloud', model: 'large', runtimeUrl: cloudUrl, runtimeKey: 'REMOTE', cloudApproved: true },
    { id: 'broken', name: 'Unavailable', kind: 'local', model: 'broken', runtimeUrl: localUrl },
  ], profiles: { fast: 'local', quality: 'cloud', cloud: 'cloud' } });
  const stop = new AbortController();
  const worker = runWorker({ server, ...paired, identity, runtimeUrl: localUrl, models: ['small'], pollMs: 10, loadRouting: async () => routing }, stop.signal);
  const ask = async (model: string, stream = false) => {
    const job = await sdk.submit({ model, messages: [{ role: 'user', content: 'private prompt' }], ...(stream ? { stream: true } : {}) });
    const result = await sdk.wait(job.id, { signal: AbortSignal.timeout(5000) });
    return result.text;
  };
  try {
    assert.equal(await ask('profile:fast'), 'local');
    assert.deepEqual(requests[0], { provider: 'local', model: 'small', key: 'Bearer LOCAL' });
    assert.equal(await ask('profile:quality'), 'cloud');
    assert.deepEqual(requests[1], { provider: 'cloud', model: 'large', key: 'Bearer REMOTE' });
    routing = { ...routing, profiles: { ...routing.profiles, fast: 'cloud' } };
    assert.equal(await ask('profile:fast', true), 'streamed');
    const before = requests.length;
    await assert.rejects(ask('profile:vision'), /Profile is not configured/);
    assert.equal(requests.length, before, 'unassigned profiles must not contact any provider');
    await assert.rejects(ask('broken'), /HTTP 503/);
    assert.equal(requests.length, before + 1, 'failed local inference must not fall back to cloud');
    routing.destinations[1]!.cloudApproved = false;
    await assert.rejects(ask('profile:cloud'), /explicit approval/);
    assert.equal(requests.length, before + 1);
    assert.ok(store.agentQueue(device.id).jobs.every(job => !JSON.stringify(job).includes('profile:')));
  } finally { stop.abort(); await worker; await app.close(); await local.close(); await cloud.close(); }
});
