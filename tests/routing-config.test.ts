import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test('routing updates preserve pairing, keep private permissions and reject invalid replacements atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pq-routing-config-'));
  const config = join(dir, 'agent.json');
  const original = { server: 'https://relay.example', token: 'PAIRING_SECRET', deviceId: crypto.randomUUID(), publicKey: 'public', privateKey: { d: 'PRIVATE_KEY' }, models: ['old'], runtimeUrl: 'http://127.0.0.1:8000/v1' };
  await writeFile(config, JSON.stringify(original), { mode: 0o600 });
  const candidate = { destinations: [{ id: 'new', name: 'New local model', model: 'new-model', runtimeUrl: 'http://127.0.0.1:9000/v1', kind: 'local', runtimeKey: 'PROVIDER_SECRET' }], profiles: { fast: 'new', quality: 'new' } };
  const run = (data: unknown) => spawnSync(process.execPath, [resolve('dist/packages/agent/cli.js'), 'configure-routing', '--config', config], { input: JSON.stringify(data), encoding: 'utf8', timeout: 5000 });
  try {
    const result = run(candidate); assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /PAIRING_SECRET|PRIVATE_KEY|PROVIDER_SECRET/);
    const saved = await readFile(config, 'utf8'), value = JSON.parse(saved);
    for (const key of ['token', 'deviceId', 'privateKey']) assert.deepEqual(value[key], original[key as keyof typeof original]);
    assert.equal(value.routing.destinations[0].runtimeKey, 'PROVIDER_SECRET');
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    const invalid = run({ ...candidate, profiles: { fast: 'missing' } });
    assert.equal(invalid.status, 1); assert.equal(await readFile(config, 'utf8'), saved);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
