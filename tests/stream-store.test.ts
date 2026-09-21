import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../packages/server/src/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('stream blocks persist, enforce sequence/idempotency, isolate clients and fence retries', () => {
  let now = 10000;
  const dir = mkdtempSync(join(tmpdir(), 'pq-stream-'));
  const path = join(dir, 'queue.sqlite');
  let store = new Store(path, { clock: () => now, leaseMs: 1000 });
  try {
    const p = store.createProject('stream', false), d = store.createDevice(p.id, 'home'); store.pair(d.pairingCode, 'key');
    const c = store.createClient(p.id, d.id, 'browser'), other = store.createClient(p.id, d.id, 'other');
    const id = crypto.randomUUID();
    store.submit(c.id, { id, ttlSeconds: 60, stream: true, payload: { mode: 'plain', data: {} } });
    const first = store.claim(d.id)!;
    const block = { mode: 'plain' as const, data: { text: 'hello' } };
    store.append(d.id, id, first.attemptId, 1, block);
    store.append(d.id, id, first.attemptId, 1, block);
    assert.throws(() => store.append(d.id, id, first.attemptId, 1, { mode: 'plain', data: { text: 'changed' } }), /stream_conflict/);
    assert.throws(() => store.append(d.id, id, first.attemptId, 3, block), /stream_sequence/);
    assert.throws(() => store.events(other.id, id, null, 0), /not_found/);
    store.close(); store = new Store(path, { clock: () => now, leaseMs: 1000 });
    assert.equal(store.events(c.id, id, first.attemptId, 0).events.length, 1);
    assert.equal(store.events(c.id, id, first.attemptId, 1).events.length, 0);
    now += 1001;
    const next = store.claim(d.id)!;
    assert.notEqual(next.attemptId, first.attemptId);
    assert.throws(() => store.append(d.id, id, first.attemptId, 2, block), /lease_lost/);
    assert.equal(store.events(c.id, id, first.attemptId, 1).events.length, 0);
    store.append(d.id, id, next.attemptId, 1, block);
    assert.equal(store.events(c.id, id, first.attemptId, 99).events[0]?.sequence, 1);
    store.finish(d.id, id, next.attemptId, { mode: 'plain', data: { text: 'hello', finishReason: 'stop' } }, true);
    assert.equal(store.events(c.id, id, next.attemptId, 0).job.status, 'succeeded');
    assert.throws(() => store.append(d.id, id, next.attemptId, 2, block), /lease_lost/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('streaming reserves storage for blocks plus final result and bounds block writes', () => {
  const store = new Store(':memory:', { storageLimitBytes: 4_000_000 });
  try {
    const p = store.createProject('bounded', false), d = store.createDevice(p.id, 'home'); store.pair(d.pairingCode, 'key');
    const c = store.createClient(p.id, d.id, 'browser');
    const id = crypto.randomUUID();
    store.submit(c.id, { id, stream: true, ttlSeconds: 60, payload: { mode: 'plain', data: {} } });
    assert.throws(() => store.submit(c.id, { id: crypto.randomUUID(), stream: true, ttlSeconds: 60, payload: { mode: 'plain', data: {} } }), /storage_quota_exceeded/);
    const job = store.claim(d.id)!;
    assert.throws(() => store.append(d.id, id, job.attemptId, 1, { mode: 'plain', data: 'x'.repeat(17000) }), /stream_block_too_large/);
    for (let sequence = 1; sequence <= 124; sequence++) store.append(d.id, id, job.attemptId, sequence, { mode: 'plain', data: 'x'.repeat(16000) });
    assert.throws(() => store.append(d.id, id, job.attemptId, 125, { mode: 'plain', data: 'x'.repeat(16000) }), /stream_budget_exceeded/);
    store.finish(d.id, id, job.attemptId, { mode: 'plain', data: { text: 'complete', finishReason: 'stop' } }, true);
    store.cancel(c.id, id); // Cancelling completed work must not erase its replay stream.
    assert.equal(store.events(c.id, id, job.attemptId, 0).events.length, 64);
    assert.equal(store.events(c.id, id, job.attemptId, 0).hasMore, true);
    assert.equal(store.events(c.id, id, job.attemptId, 64).events.length, 60);
  } finally { store.close(); }
});
