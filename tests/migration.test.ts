import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/server/src/store.js';
test('v1 project and owner credentials survive the additive SaaS migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pq-migrate-'));
  const path = join(directory, 'queue.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_hash TEXT NOT NULL UNIQUE,require_encryption INTEGER NOT NULL); PRAGMA user_version=1;');
    db.prepare('INSERT INTO projects VALUES(?,?,?,1)').run('legacy-project', 'Legacy', createHash('sha256').update('old-owner-key').digest('hex')); db.close();
    const store = new Store(path);
    assert.equal(store.owner('old-owner-key').id, 'legacy-project');
    assert.equal(store.accounts.plan('legacy-project'), undefined);
    store.createDevice('legacy-project', 'existing customer'); store.close();
    const restarted = new Store(path); assert.equal(restarted.devices('legacy-project').length, 1); restarted.close();
    const inspected = new DatabaseSync(path); assert.equal(inspected.prepare('PRAGMA user_version').get()?.user_version, 3); inspected.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
