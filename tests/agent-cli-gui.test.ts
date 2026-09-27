import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../packages/server/src/app.js';
import { generateIdentity } from '../packages/protocol/src/crypto.js';

test('packaged CLI opens an authenticated monitor and preserves the queue without consuming jobs', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pq-gui-cli-'));
  const { app, store } = await createServer({ database: ':memory:', adminToken: 't'.repeat(40) });
  const server = await app.listen({ host: '127.0.0.1', port: 0 });
  const project = store.createProject('Test', false), device = store.createDevice(project.id, 'Home');
  const identity = await generateIdentity();
  const agent = store.pair(device.pairingCode, identity.publicKey);
  const client = store.createClient(project.id, device.id, 'Browser');
  const job = store.submit(client.id, { id: crypto.randomUUID(), ttlSeconds: 60, payload: { mode: 'plain', data: 'private' } });
  const config = join(directory, 'agent.json');
  await writeFile(config, JSON.stringify({ server, ...agent, publicKey: identity.publicKey, privateKey: {}, runtimeUrl: 'http://localhost:8000/v1', models: ['model'] }), { mode: 0o600 });
  const child = spawn(process.execPath, [resolve('dist/packages/agent/cli.js'), 'gui', '--headless', '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  try {
    const url = await new Promise<URL>((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new Error('CLI did not open the dashboard')), 8000);
      child.stdout.on('data', chunk => { output += chunk; const match = /Local dashboard: (http:\/\/\S+)/.exec(output); if (match) { clearTimeout(timeout); resolve(new URL(match[1]!)); } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('CLI exited before dashboard startup')); });
    });
    const response = await fetch(`${url.origin}/api/status`, { headers: { authorization: `Bearer ${url.hash.slice(1)}` } });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.consuming, false); assert.equal(state.queue.counts.queued, 1);
    assert.equal(store.getJob(client.id, job.id).status, 'queued');
    child.kill('SIGTERM'); assert.equal(await exit, 0);
    await assert.rejects(fetch(url.origin));
  } finally { child.kill('SIGTERM'); await exit; await app.close(); await rm(directory, { recursive: true, force: true }); }
});
