import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { createServer } from '../packages/server/src/app.js';
import { generateIdentity } from '../packages/protocol/src/crypto.js';
import { PublicQueue, MemoryIdentityStore } from '../packages/sdk/src/index.js';

// Uses a separately identified app and a temporary device; never touches the user's app or relay.
test('packaged macOS app runs encrypted inference without system Node and leaves no orphan agent after a crash', { skip: process.platform !== 'darwin', timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pq-macos-'));
  const name = `Public Queue Test ${crypto.randomUUID()}`;
  const support = join(homedir(), 'Library/Application Support', name);
  const appPath = join(directory, 'Test.app');
  const source = resolve('dist/macos/Public Queue.app');
  const { app, store } = await createServer({ database: ':memory:', adminToken: 'a'.repeat(40) });
  const runtime = Fastify();
  runtime.post('/v1/chat/completions', async () => ({ choices: [{ message: { content: 'Native app inference passed' }, finish_reason: 'stop' }] }));
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> | undefined;
  let workerPid: number | undefined;
  try {
    const server = await app.listen({ host: '127.0.0.1', port: 0 });
    const runtimeUrl = `${await runtime.listen({ host: '127.0.0.1', port: 0 })}/v1`;
    await cp(source, appPath, { recursive: true });
    const plist = join(appPath, 'Contents/Info.plist');
    execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', `it.grokked.test.${crypto.randomUUID()}`, plist]);
    execFileSync('plutil', ['-replace', 'CFBundleName', '-string', name, plist]);
    execFileSync('codesign', ['--force', '--sign', '-', appPath], { stdio: 'ignore' });
    const project = store.createProject('Native test'), device = store.createDevice(project.id, 'Test Mac');
    const identity = await generateIdentity(true);
    const paired = store.pair(device.pairingCode, identity.publicKey);
    const client = store.createClient(project.id, device.id, 'Browser');
    await mkdir(support, { mode: 0o700 });
    await writeFile(join(support, 'fixture.json'), JSON.stringify({ server, ...paired, publicKey: identity.publicKey, privateKey: await crypto.subtle.exportKey('jwk', identity.privateKey), runtimeUrl, models: ['fixture'] }), { mode: 0o600 });
    const sdk = new PublicQueue({ server, token: client.token, deviceId: device.id, publicKey: identity.publicKey, identityStore: new MemoryIdentityStore(), pollMs: 50 });
    const job = await sdk.submit({ model: 'fixture', messages: [{ role: 'user', content: 'Test app packaging' }] });
    child = spawn(join(appPath, 'Contents/MacOS/PublicQueue'), ['-configuration', 'fixture.json', '-loginPreferenceSet', 'YES'], { env: { ...process.env, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    child.stderr?.on('data', chunk => { diagnostics += String(chunk); });
    exited = new Promise<void>((resolve, reject) => { child!.once('exit', () => resolve()); child!.once('error', reject); });
    const result = await Promise.race([sdk.wait(job.id, { signal: AbortSignal.timeout(30000) }), exited.then(() => { throw new Error(`Native app exited: ${diagnostics}`); })]);
    assert.equal(result.text, 'Native app inference passed');
    const children = execFileSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' }).trim().split('\n');
    assert.equal(children.length, 1, 'one owned agent, no duplicate menu helper');
    workerPid = Number(children[0]);
    child.kill('SIGKILL'); await exited;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(workerPid, 0); } catch { workerPid = undefined; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(workerPid, undefined, 'bundled Node must exit when native owner crashes');
  } finally {
    child?.kill('SIGKILL'); await exited;
    if (workerPid) { try { process.kill(workerPid, 'SIGKILL'); } catch {} }
    await app.close(); await runtime.close();
    await rm(support, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true });
  }
});
