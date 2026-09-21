import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../packages/server/src/app.js';
import { generateIdentity } from '../packages/protocol/src/crypto.js';
import { PublicQueue, MemoryIdentityStore } from '../packages/sdk/src/index.js';
import { runWorker } from '../packages/agent/src/worker.js';

const adminToken = 'test-administrator-'.repeat(3);
test('real HTTP: encrypted offline submission, server restart, local inference, browser resume, revocation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pq-e2e-'));
  const database = join(directory, 'jobs.sqlite');
  let service = await createServer({ database, adminToken, leaseMs: 900 });
  const runtime = Fastify();
  let calls = 0;
  runtime.post('/v1/chat/completions', async request => {
    calls++;
    const body = request.body as { model: string; messages: { content: string }[] };
    assert.equal(body.model, 'private-model');
    assert.equal(body.messages[0]?.content, 'PRIVATE PROMPT 9e32');
    await new Promise(resolve => setTimeout(resolve, 1200)); // requires successful heartbeat
    return { choices: [{ message: { content: 'PRIVATE RESPONSE b541' }, finish_reason: 'stop' }] };
  });
  const runtimeUrl = await runtime.listen({ host: '127.0.0.1', port: 0 });
  let base = await service.app.listen({ host: '127.0.0.1', port: 0 });
  const port = new URL(base).port;
  const post = async (path: string, body: unknown, token = adminToken) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    assert.ok(response.ok, await response.clone().text()); return response.json();
  };
  const stop = new AbortController(); let worker: Promise<void> | undefined;
  try {
    const project = await post('/v1/projects', { name: 'Test' }) as { ownerToken: string };
    const device = await post('/v1/devices', { name: 'Home' }, project.ownerToken) as { id: string; pairingCode: string };
    const identity = await generateIdentity();
    const paired = await post('/v1/pair', { code: device.pairingCode, publicKey: identity.publicKey }) as { token: string; deviceId: string };
    const client = await post('/v1/clients', { name: 'Browser', deviceId: device.id }, project.ownerToken) as { token: string; id: string };
    const connection = { server: base, token: client.token, deviceId: device.id, publicKey: identity.publicKey, identityStore: new MemoryIdentityStore(), pollMs: 50 };
    const sdk = new PublicQueue(connection);
    const job = await sdk.submit({ model: 'private-model', messages: [{ role: 'user', content: 'PRIVATE PROMPT 9e32' }] });
    assert.equal(job.status, 'queued');
    await service.app.close();
    service = await createServer({ database, adminToken, leaseMs: 900 });
    base = await service.app.listen({ host: '127.0.0.1', port: Number(port) });
    assert.equal((await sdk.get(job.id)).status, 'queued');
    worker = runWorker({ server: base, token: paired.token, deviceId: device.id, identity, runtimeUrl: `${runtimeUrl}/v1`, models: ['private-model'], pollMs: 30 }, stop.signal);
    const resumed = new PublicQueue(connection);
    const result = await resumed.wait(job.id, { signal: AbortSignal.timeout(10000) });
    assert.equal(result.text, 'PRIVATE RESPONSE b541'); assert.equal(calls, 1);
    const badClient = await post('/v1/clients', { name: 'Other browser', deviceId: device.id }, project.ownerToken) as { token: string };
    const denied = await fetch(`${base}/v1/jobs/${job.id}`, { headers: { Authorization: `Bearer ${badClient.token}` } });
    assert.equal(denied.status, 404);
    const wrongIdentity = new PublicQueue({ ...connection, identityStore: new MemoryIdentityStore() });
    await assert.rejects(wrongIdentity.result(await sdk.get(job.id)));
    const revoked = await fetch(`${base}/v1/clients/${client.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${project.ownerToken}` } });
    assert.equal(revoked.status, 200);
    await assert.rejects(sdk.list(), /unauthorized/);
    stop.abort(); await worker; worker = undefined;
    await service.app.close();
    const contents = readFileSync(database).toString('latin1');
    assert.equal(contents.includes('PRIVATE PROMPT'), false);
    assert.equal(contents.includes('PRIVATE RESPONSE'), false);
    assert.equal(contents.includes('private-model'), false);
  } finally {
    stop.abort(); await worker; await service.app.close(); await runtime.close(); rmSync(directory, { recursive: true });
  }
});

test('HTTP: validation, owner/agent/client separation and plaintext policy', async () => {
  const { app, store } = await createServer({ database: ':memory:', adminToken });
  try {
    const project = store.createProject('Private'); const device = store.createDevice(project.id, 'Home');
    const identity = await generateIdentity(); const agent = store.pair(device.pairingCode, identity.publicKey);
    const client = store.createClient(project.id, device.id, 'Browser');
    const body = { id: crypto.randomUUID(), ttlSeconds: 60, payload: { mode: 'plain', data: {} } };
    const rejected = await app.inject({ method: 'POST', url: '/v1/jobs', headers: { authorization: `Bearer ${client.token}` }, payload: body });
    assert.equal(rejected.statusCode, 400); assert.equal(rejected.json().error, 'encryption_required');
    for (const token of [client.token, agent.token]) {
      assert.equal((await app.inject({ method: 'POST', url: '/v1/devices', headers: { authorization: `Bearer ${token}` }, payload: { name: 'bad' } })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/v1/agent/claim', headers: { authorization: `Bearer ${client.token}` }, payload: {} })).statusCode, 401);
    const malformed = await app.inject({ method: 'POST', url: '/v1/jobs', headers: { authorization: `Bearer ${client.token}` }, payload: { id: 'not-a-uuid', payload: { mode: 'encrypted', data: {} } } });
    assert.equal(malformed.statusCode, 400); assert.equal(malformed.json().error, 'invalid_request');

    assert.equal((await app.inject({ method: 'POST', url: '/v1/pair', payload: { code: 'x'.repeat(43), publicKey: 'x'.repeat(87) } })).statusCode, 400);
  } finally { await app.close(); }
});
