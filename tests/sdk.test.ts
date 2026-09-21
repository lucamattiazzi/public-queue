import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicQueue } from '../packages/sdk/src/index.js';

test('a status read retries a connection reset after server restart', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) throw new TypeError('fetch failed');
    return Response.json({ id: 'test-job', status: 'queued' });
  };
  try {
    const client = new PublicQueue({ server: 'http://127.0.0.1:8787', deviceId: 'test', publicKey: 'test', token: 'test' });
    assert.equal((await client.get('test-job')).status, 'queued');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
