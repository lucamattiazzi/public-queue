import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startDashboard } from '../packages/agent/src/dashboard.js';
import type { AgentQueue } from '../packages/protocol/src/index.js';
const queue: AgentQueue = { counts: { queued: 1, running: 0, succeeded: 0, failed: 0, cancelled: 0, expired: 0 }, jobs: [], hasMore: false };

test('dashboard binds loopback and protects local data against cross-origin and unauthenticated requests', async () => {
  let calls = 0;
  const dashboard = await startDashboard({ server: 'https://relay.example', deviceId: 'device', runtimeUrl: 'http://127.0.0.1:8000/v1', models: ['model'], consuming: true, loadQueue: async () => { calls++; return queue; } });
  const url = new URL(dashboard.url);
  const headers = { authorization: `Bearer ${url.hash.slice(1)}` };
  try {
    assert.equal(url.hostname, '127.0.0.1');
    const root = await fetch(url.origin);
    assert.equal(root.status, 200);
    assert.equal((await root.text()).includes(url.hash.slice(1)), false);
    assert.equal((await fetch(`${url.origin}/api/status`)).status, 401);
    assert.equal((await fetch(`${url.origin}/api/status`, { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
    const rebound = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${url.origin}/api/status`, { headers: { ...headers, host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(rebound, 403);
    assert.equal((await fetch(`${url.origin}/api/status`, { method: 'POST', headers })).status, 405);
    assert.equal(calls, 0);
    const status = await fetch(`${url.origin}/api/status`, { headers });
    assert.equal(status.status, 200);
    assert.equal(status.headers.get('access-control-allow-origin'), null);
    assert.equal(status.headers.get('cache-control'), 'no-store');
    const body = await status.json();
    assert.equal(body.queue.counts.queued, 1);
    assert.equal(body.consuming, true);
    assert.equal(calls, 1);
    assert.equal((await fetch(`${url.origin}/config`)).status, 404);
  } finally { await dashboard.close(); }
});

test('relay failures are reported without leaking arbitrary upstream errors or inventing an empty queue', async () => {
  const dashboard = await startDashboard({ server: 'https://relay.example', deviceId: 'device', runtimeUrl: 'http://localhost:8000/v1', models: ['model'], consuming: false, loadQueue: async () => { throw Error('SECRET runtime credentials'); } });
  const url = new URL(dashboard.url);
  try {
    const r = await fetch(`${url.origin}/api/status`, { headers: { authorization: `Bearer ${url.hash.slice(1)}` } });
    assert.equal(r.status, 503);
    const text = await r.text();
    assert.equal(text.includes('SECRET'), false);
    assert.equal(text.includes('"queue"'), false);
  } finally { await dashboard.close(); }
});

test('dashboard refreshes routing metadata without exposing provider credentials', async () => {
  const routing = { destinations: [{ id: 'local', name: 'Local', model: 'new-model', runtimeUrl: 'http://127.0.0.1:9090/v1', kind: 'local' as const, cloudApproved: false, runtimeKey: 'PROVIDER_SECRET' }], profiles: { fast: 'local' } };
  const dashboard = await startDashboard({ server: 'https://relay.example', deviceId: 'device', runtimeUrl: 'http://localhost:8000/v1', models: ['old-model'], consuming: true, loadQueue: async () => queue, loadRouting: async () => routing });
  const url = new URL(dashboard.url);
  try {
    const response = await fetch(`${url.origin}/api/status`, { headers: { authorization: `Bearer ${url.hash.slice(1)}` } });
    const body = await response.json();
    assert.deepEqual(body.models, ['new-model']);
    assert.deepEqual(body.profiles, { fast: 'new-model' });
    assert.equal(JSON.stringify(body).includes('PROVIDER_SECRET'), false);
    routing.destinations[0]!.model = 'changed-model';
    const next = await fetch(`${url.origin}/api/status`, { headers: { authorization: `Bearer ${url.hash.slice(1)}` } });
    assert.deepEqual((await next.json()).models, ['changed-model']);
  } finally { await dashboard.close(); }
});
