import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../packages/server/src/store.js';

test('online backup includes committed WAL jobs and can be restored independently', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pq-backup-')); const source = join(dir, 'live.sqlite'), backup = join(dir, 'backup.sqlite');
  const store = new Store(source);
  try {
    const project = store.createProject('Backup', false), device = store.createDevice(project.id, 'Home');
    const client = store.createClient(project.id, device.id, 'Browser');
    const job = store.submit(client.id, { id: crypto.randomUUID(), ttlSeconds: 3600, payload: { mode: 'plain', data: { message: 'backup me' } } });
    execFileSync(process.execPath, [resolve('scripts/backup.mjs'), source, backup]);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    const restored = new Store(backup);
    try { assert.equal(restored.getJob(client.id, job.id).status, 'queued'); restored.cancel(client.id, job.id); }
    finally { restored.close(); }
    assert.equal(store.getJob(client.id, job.id).status, 'queued');
    assert.throws(() => execFileSync(process.execPath, [resolve('scripts/backup.mjs'), source, backup], { stdio: 'pipe' }));
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
