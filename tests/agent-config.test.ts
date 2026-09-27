import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('an unpaired agent explains how to connect without creating a configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pq-unpaired-'));
  try {
    for (const command of ['start', 'gui', 'doctor']) {
      const result = spawnSync(process.execPath, [resolve('dist/packages/agent/cli.js'), command, '--config', join(directory, 'missing.json')], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /pq-agent connect/);
      assert.match(result.stderr, /--config/);
      assert.doesNotMatch(result.stderr, /ENOENT/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
