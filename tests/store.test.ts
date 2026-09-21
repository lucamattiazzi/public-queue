import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/server/src/store.js';

function setup(path = ':memory:', clock = () => Date.now()) {
  const store = new Store(path, { clock, leaseMs: 1000 });
  const project = store.createProject('My app', false);
  const device = store.createDevice(project.id, 'Home');
  const agent = store.pair(device.pairingCode, 'public-key');
  const client = store.createClient(project.id, device.id, 'Browser');
  return { store, project, device, agent, client };
}
const payload = { mode: 'plain' as const, data: { model: 'test', messages: [{ role: 'user', content: 'hello' }] } };

test('offline job survives restart; results are durable and scoped to its client', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pq-'));
  const path = join(dir, 'queue.sqlite');
  const a = setup(path);
  const id = crypto.randomUUID();
  a.store.submit(a.client.id, { id, payload, ttlSeconds: 3600 });
  a.store.close();
  const store = new Store(path);
  try {
    assert.equal(store.getJob(a.client.id, id).status, 'queued');
    const work = store.claim(a.device.id)!;
    store.finish(a.device.id, id, work.attemptId!, { mode: 'plain', data: { text: 'done' } }, true);
    assert.deepEqual(store.getJob(a.client.id, id).result, { mode: 'plain', data: { text: 'done' } });
    const other = store.createClient(a.project.id, a.device.id, 'Other browser');
    assert.throws(() => store.getJob(other.id, id), /not_found/);
    assert.throws(() => store.pair(a.device.pairingCode, 'other-key'), /invalid_pairing/);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('lease recovery fences stale attempts; retries are bounded; cancel cannot be completed', () => {
  let now = 10000;
  const { store, client, device } = setup(':memory:', () => now);
  try {
    const id = crypto.randomUUID();
    store.submit(client.id, { id, payload, ttlSeconds: 3600 });
    const first = store.claim(device.id)!;
    assert.equal(store.claim(device.id), null);
    now += 1001;
    const second = store.claim(device.id)!;
    assert.notEqual(second.attemptId, first.attemptId);
    assert.throws(() => store.finish(device.id, id, first.attemptId!, payload, true), /lease_lost/);
    store.cancel(client.id, id);
    assert.throws(() => store.heartbeat(device.id, id, second.attemptId!), /lease_lost/);
    assert.throws(() => store.finish(device.id, id, second.attemptId!, payload, true), /lease_lost/);
    const retryId = crypto.randomUUID();
    store.submit(client.id, { id: retryId, payload, ttlSeconds: 3600 });
    for (let i = 0; i < 3; i++) { assert.ok(store.claim(device.id)); now += 1001; }
    assert.equal(store.claim(device.id), null);
    assert.equal(store.getJob(client.id, retryId).status, 'failed');
  } finally { store.close(); }
});

test('idempotency, expiry, encryption policy and tenant boundaries', () => {
  let now = 10000;
  const { store, client, device } = setup(':memory:', () => now);
  try {
    const id = crypto.randomUUID();
    store.submit(client.id, { id, payload, ttlSeconds: 60 });
    assert.equal(store.submit(client.id, { id, payload, ttlSeconds: 60 }).id, id);
    assert.throws(() => store.submit(client.id, { id, payload: { mode: 'plain', data: {} }, ttlSeconds: 60 }), /idempotency_conflict/);
    const project = store.createProject('Encrypted', true);
    assert.throws(() => store.createClient(project.id, device.id, 'Wrong tenant'), /not_found/);
    const encryptedDevice = store.createDevice(project.id, 'Private');
    const encryptedClient = store.createClient(project.id, encryptedDevice.id, 'Private browser');
    assert.throws(() => store.submit(encryptedClient.id, { id: crypto.randomUUID(), payload, ttlSeconds: 60 }), /encryption_required/);
    now += 60001;
    assert.equal(store.claim(device.id), null);
    assert.equal(store.getJob(client.id, id).status, 'expired');
  } finally { store.close(); }
});

test('completion is idempotent, cannot change encryption mode, and revoked devices cannot claim', () => {
  const { store, project, client, device } = setup();
  try {
    const id = crypto.randomUUID();
    store.submit(client.id, { id, payload, ttlSeconds: 3600 });
    const job = store.claim(device.id)!;
    const encrypted = { mode: 'encrypted' as const, data: { version: 1 as const, publicKey: 'key', iv: 'iv', ciphertext: 'body' } };
    assert.throws(() => store.finish(device.id, id, job.attemptId, encrypted, true), /encryption_mode_mismatch/);
    store.finish(device.id, id, job.attemptId, payload, true);
    store.finish(device.id, id, job.attemptId, payload, true);
    assert.throws(() => store.finish(device.id, id, job.attemptId, { mode: 'plain', data: 'replacement' }, true), /lease_lost/);
    store.revoke(project.id, device.id, 'device');
    assert.throws(() => store.claim(device.id), /unauthorized/);
  } finally { store.close(); }
});

test('daily quotas survive expiry and retention cannot silently reopen the same-day budget', () => {
  let now = 10000;
  const store = new Store(':memory:', { clock: () => now, dailyLimit: 1, retentionMs: 10 });
  const project = store.createProject('Quota', false); const device = store.createDevice(project.id, 'Home');
  const client = store.createClient(project.id, device.id, 'Client');
  try {
    store.submit(client.id, { id: crypto.randomUUID(), payload, ttlSeconds: 60 });
    now += 60001; store.sweep(); now += 11; store.sweep();
    assert.throws(() => store.submit(client.id, { id: crypto.randomUUID(), payload, ttlSeconds: 60 }), /quota_exceeded/);
  } finally { store.close(); }
});

test('reserves storage for a completion before accepting a job', () => {
  const store = new Store(':memory:', { storageLimitBytes: 2_000_100 });
  const project = store.createProject('Storage', false); const device = store.createDevice(project.id, 'Home');
  const client = store.createClient(project.id, device.id, 'Client');
  try {
    const job = store.submit(client.id, { id: crypto.randomUUID(), payload, ttlSeconds: 60 });
    assert.throws(() => store.submit(client.id, { id: crypto.randomUUID(), payload, ttlSeconds: 60 }), /storage_quota_exceeded/);
    store.cancel(client.id, job.id);
    assert.ok(store.submit(client.id, { id: crypto.randomUUID(), payload, ttlSeconds: 60 }));
  } finally { store.close(); }
});
