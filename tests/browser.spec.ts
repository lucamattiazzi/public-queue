import { test, expect } from '@playwright/test';
import Fastify from 'fastify';
import { createServer } from '../packages/server/src/app.js';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

// Exercises the built browser and agent; model HTTP server is explicitly simulated.
test('onboard, queue offline, refresh, run packaged agent, decrypt and view on mobile', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'pq-browser-'));
  const configPath = join(dir, 'agent.json');
  const adminToken = 'browser-test-admin-token-'.repeat(3);
  const { app } = await createServer({ database: join(dir, 'db.sqlite'), adminToken, webRoot: resolve('dist/web') });
  const runtime = Fastify();
  runtime.get('/v1/models', async () => ({ data: [{ id: 'demo-model' }] }));
  runtime.post('/v1/chat/completions', async () => ({ choices: [{ message: { content: 'The browser recovered this encrypted result after a refresh.' }, finish_reason: 'stop' }] }));
  const runtimeUrl = await runtime.listen({ host: '127.0.0.1', port: 0 });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  let agent: ChildProcess | undefined;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${base}/console/`);
    await page.locator('#stream-response').uncheck();
    await page.getByText('Hosting this service yourself?').click();
    await page.getByLabel('Administrator key', { exact: true }).fill(adminToken);
    await page.getByRole('button', { name: 'Create encrypted project' }).click();
    await expect(page.locator('#project-badge')).toHaveText('My local AI');
    await page.getByRole('button', { name: 'Create pairing code' }).click();
    await expect(page.locator('#pair-command')).toContainText('pq-agent connect');
    const command = await page.locator('#pair-command').textContent();
    const code = /--code (\S+)/.exec(command!)![1]!;
    const pairing = spawn(process.execPath, [resolve('dist/packages/agent/cli.js'), 'connect', '--server', base, '--code', code, '--runtime', 'custom', '--runtime-url', `${runtimeUrl}/v1`, '--models', 'demo-model', '--config', configPath], { stdio: 'pipe' });
    const exit = await new Promise<number | null>((resolve, reject) => { pairing.once('exit', resolve); pairing.once('error', reject); });
    expect(exit).toBe(0);
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { publicKey: string };
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByLabel('Public key copied from your agent').fill(config.publicKey);
    await page.getByRole('button', { name: 'Create browser connection' }).click();
    await page.getByRole('button', { name: 'Open in playground' }).click();
    await page.getByLabel('Local model name').fill('demo-model');
    await page.getByLabel('What would you like to do?').fill('A private test prompt');
    await page.getByRole('button', { name: 'Queue encrypted job' }).click();
    await expect(page.locator('#job-status')).toHaveText('queued');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Follow job' })).toBeVisible();
    agent = spawn(process.execPath, [resolve('dist/packages/agent/cli.js'), 'start', '--headless', '--config', configPath], { stdio: 'pipe' });
    await page.getByRole('button', { name: 'Follow job' }).click();
    await expect(page.locator('#output')).toContainText('recovered this encrypted result', { timeout: 15000 });
    await expect(page.locator('#job-status')).toHaveText('succeeded');
    await page.reload();
    await page.getByRole('button', { name: 'Open result' }).click();
    await expect(page.locator('#output')).toContainText('recovered this encrypted result');
    await page.screenshot({ path: 'test-results/console-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: 'test-results/console-mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    if (agent) { const exited = new Promise(resolve => agent!.once('exit', resolve)); agent.kill('SIGTERM'); await exited; }
    await app.close(); await runtime.close(); rmSync(dir, { recursive: true });
  }
});

test('two SDK instances share a non-extractable browser identity without losing decryption', async ({ page }) => {
  const { app } = await createServer({ database: ':memory:', adminToken: 'identity-test-secret-'.repeat(3), webRoot: resolve('dist/web') });
  try {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    await page.goto(`${base}/console/`);
    await page.locator('#stream-response').uncheck();
    const result = await page.evaluate(async () => {
      const sdk = await import(`${location.origin}/sdk.js`) as typeof import('../packages/sdk/src/index.js');
      const a = new sdk.BrowserIdentityStore(), b = new sdk.BrowserIdentityStore();
      const makeIdentity = async () => {
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
        return { privateKey: pair.privateKey, publicKey: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))) };
      };
      const [first, second] = await Promise.all([makeIdentity(), makeIdentity()]);
      await Promise.all([a.set('race-scope', first), b.set('race-scope', second)]);
      const [left, right] = await Promise.all([a.get('race-scope'), b.get('race-scope')]);
      let exportRejected = false;
      try { await crypto.subtle.exportKey('jwk', left!.privateKey); } catch { exportRejected = true; }
      return { sameKey: left!.publicKey === right!.publicKey, exportRejected };
    });
    expect(result).toEqual({ sameKey: true, exportRejected: true });
  } finally { await app.close(); }
});

test('independently hosted static HTML uses CORS and the bundled SDK', async ({ page }) => {
  const { generateIdentity } = await import('../packages/protocol/src/crypto.js');
  const { runWorker } = await import('../packages/agent/src/worker.js');
  const frontend = Fastify();
  frontend.get('/', async (_request, reply) => reply.type('text/html').send(readFileSync('examples/static/index.html', 'utf8')));
  frontend.get('/app.js', async (_request, reply) => reply.type('text/javascript').send(readFileSync('examples/static/app.js', 'utf8')));
  frontend.get('/sdk.js', async (_request, reply) => reply.type('text/javascript').send(readFileSync('dist/packages/sdk/index.js', 'utf8')));
  const origin = await frontend.listen({ host: '127.0.0.1', port: 0 });
  const { app, store } = await createServer({ database: ':memory:', adminToken: 'static-test-admin-'.repeat(3), origins: [origin] });
  const server = await app.listen({ host: '127.0.0.1', port: 0 });
  const runtime = Fastify();
  runtime.post('/v1/chat/completions', async () => ({ choices: [{ message: { content: 'Independent static frontend works.' }, finish_reason: 'stop' }] }));
  const runtimeUrl = await runtime.listen({ host: '127.0.0.1', port: 0 });
  const project = store.createProject('Static'); const device = store.createDevice(project.id, 'Home');
  const identity = await generateIdentity(); const agent = store.pair(device.pairingCode, identity.publicKey);
  const client = store.createClient(project.id, device.id, 'Static browser');
  const stop = new AbortController();
  const worker = runWorker({ server, token: agent.token, deviceId: device.id, identity, runtimeUrl: `${runtimeUrl}/v1`, models: ['model'], pollMs: 30 }, stop.signal);
  try {
    await page.goto(`${origin}/console/`);
    await page.locator('#connection').fill(JSON.stringify({ server, token: client.token, deviceId: device.id, publicKey: identity.publicKey, encrypted: false }));
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('#status')).toContainText('Connected.');
    await page.locator('#model').fill('model'); await page.locator('#prompt').fill('Hello from another origin');
    await page.getByRole('button', { name: 'Send encrypted job' }).click();
    await expect(page.locator('#output')).toHaveText('Independent static frontend works.');
    expect(new URL(page.url()).origin).not.toBe(server);
  } finally { stop.abort(); await worker; await runtime.close(); await app.close(); await frontend.close(); }
});
