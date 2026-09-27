import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../packages/server/src/app.js';
import { generateIdentity } from '../packages/protocol/src/crypto.js';

test('agent queue is device-scoped, read-only and excludes request/result content', async () => {
  const { app, store } = await createServer({ database: ':memory:', adminToken: 'a'.repeat(40) });
  try {
    const project = store.createProject('Personal', false);
    const identity = await generateIdentity();
    const devices = ['Home', 'Other'].map(name => store.createDevice(project.id, name));
    const agents = devices.map(device => store.pair(device.pairingCode, identity.publicKey));
    const clients = devices.map(device => store.createClient(project.id, device.id, 'Browser'));
    const jobs = clients.map(client => store.submit(client.id, { id: crypto.randomUUID(), ttlSeconds: 300, payload: { mode: 'plain', data: { secret: 'private prompt' } } }));
    const headers = { authorization: `Bearer ${agents[0]!.token}` };
    const get = () => app.inject({ url: '/v1/agent/queue', headers });
    const queued = await get();
    assert.equal(queued.statusCode, 200);
    assert.equal(queued.json().counts.queued, 1);
    assert.deepEqual(queued.json().jobs.map((job: { id: string }) => job.id), [jobs[0]!.id]);
    assert.equal(store.getJob(clients[0]!.id, jobs[0]!.id).status, 'queued');
    const assignment = store.claim(devices[0]!.id)!;
    assert.equal((await get()).json().counts.running, 1);
    store.finish(devices[0]!.id, assignment.id, assignment.attemptId, { mode: 'plain', data: { secret: 'private result' } }, true);
    const done = await get();
    assert.equal(done.json().counts.succeeded, 1);
    assert.equal(done.json().counts.queued, 0);
    assert.equal(done.body.includes('private'), false);
    assert.equal('result' in done.json().jobs[0], false);
    assert.equal('payload' in done.json().jobs[0], false);
    for (const token of ['', clients[0]!.token, project.ownerToken]) {
      assert.equal((await app.inject({ url: '/v1/agent/queue', headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
    }
    store.revoke(project.id, devices[0]!.id, 'device');
    assert.equal((await get()).statusCode, 401);
  } finally { await app.close(); }
});
