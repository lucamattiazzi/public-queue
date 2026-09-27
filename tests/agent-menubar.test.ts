import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startDashboard } from '../packages/agent/src/dashboard.js';
const executable = resolve('packages/agent/native/public-queue-menubar');

test('native menu bar is universal, starts and exits when its parent closes stdin', { skip: process.platform !== 'darwin', timeout: 15000 }, async () => {
  const architectures = execFileSync('xcrun', ['lipo', '-archs', executable], { encoding: 'utf8' });
  assert.match(architectures, /arm64/); assert.match(architectures, /x86_64/);
  assert.match(execFileSync(executable, ['--check'], { encoding: 'utf8' }), /Public Queue/);
  const dashboard = await startDashboard({ server: 'https://relay.example', deviceId: 'test', runtimeUrl: 'http://localhost:8000/v1', models: ['test'], consuming: false,
    loadQueue: async () => ({ counts: { queued: 2, running: 1, succeeded: 0, failed: 0, expired: 0, cancelled: 0 }, jobs: [], hasMore: false }) });
  const child = spawn(executable, [dashboard.url, 'monitor'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Native status item did not start')), 8000);
      child.stdout.on('data', chunk => { if (chunk.toString().includes('ready')) { clearTimeout(timeout); resolve(); } });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Native helper exited before ready')); });
    });
    child.stdin.end();
    assert.equal(await exit, 0);
  } finally { child.kill('SIGTERM'); await dashboard.close(); }
});
