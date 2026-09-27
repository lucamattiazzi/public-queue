import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { startDashboard } from '../packages/agent/src/dashboard.js';
import { agentRequest } from '../packages/agent/src/worker.js';
import { createServer } from '../packages/server/src/app.js';
import { generateIdentity } from '../packages/protocol/src/crypto.js';
import type { AgentQueue } from '../packages/protocol/src/index.js';

test('local GUI shows real relay queue transitions, empty state, stale state and mobile/dark layout', async () => {
  const { app, store } = await createServer({ database: ':memory:', adminToken: 'g'.repeat(40) });
  const server = await app.listen({ host: '127.0.0.1', port: 0 });
  const project = store.createProject('GUI test', false);
  const device = store.createDevice(project.id, 'Home');
  const identity = await generateIdentity();
  const agent = store.pair(device.pairingCode, identity.publicKey);
  const client = store.createClient(project.id, device.id, 'Frontend');
  const dashboard = await startDashboard({ server, deviceId: device.id, runtimeUrl: 'http://127.0.0.1:8000/v1', models: ['local-model'], consuming: false,
    loadQueue: () => agentRequest<AgentQueue>(server, agent.token, '/v1/agent/queue', undefined) });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(dashboard.url);
    await page.locator('#empty').filter({ hasText: 'No jobs' }).waitFor({ timeout: 6000 });
    assert.equal(new URL(page.url()).hash, '');
    const job = store.submit(client.id, { id: crypto.randomUUID(), ttlSeconds: 300, payload: { mode: 'plain', data: 'PRIVATE CONTENT NEVER IN GUI' } });
    await page.locator('.job').filter({ hasText: job.id }).waitFor({ timeout: 8000 });
    assert.equal(await page.locator('#queued').textContent(), '1');
    const assignment = store.claim(device.id)!;
    await page.waitForFunction(() => document.getElementById('running')?.textContent === '1', { timeout: 8000 });
    await page.screenshot({ path: 'test-results/local-agent-desktop.png', fullPage: true });
    store.finish(device.id, assignment.id, assignment.attemptId, { mode: 'plain', data: 'PRIVATE RESULT NEVER IN GUI' }, true);
    await page.waitForFunction(() => document.getElementById('succeeded')?.textContent === '1', { timeout: 8000 });
    await page.reload();
    await page.locator('#status').filter({ hasText: 'up to date' }).waitFor();
    assert.equal((await page.locator('body').innerText()).includes('PRIVATE'), false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: 'test-results/local-agent-mobile-dark.png', fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await app.close();
    await page.locator('#status.error').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.job').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await dashboard.close(); await app.close(); }
});
