import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { createServer } from '../packages/server/src/app.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { generateIdentity } from '../packages/protocol/src/crypto.js';
import { runWorker } from '../packages/agent/src/worker.js';

if (!existsSync('dist/web/index.html')) throw new Error('Run pnpm build before pnpm demo');
const runtime = Fastify();
runtime.get('/v1/models', async () => ({ data: [{ id: 'demo-model' }] }));
runtime.post('/v1/chat/completions', async (request, reply) => {
  const text = 'Your encrypted job made the round trip. This is a simulated model response, not real inference. Refresh and reopen the job to replay its encrypted result.';
  if (!(request.body as { stream?: boolean }).stream) return { choices: [{ message: { content: text }, finish_reason: 'stop' }] };
  return reply.type('text/event-stream').send(Readable.from((async function* () {
    for (const word of text.split(' ')) {
      yield `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: word + ' ' }, finish_reason: null }] })}\n\n`;
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    yield `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
    yield 'data: [DONE]\n\n';
  })()));
});
const runtimeUrl = await runtime.listen({ host: '127.0.0.1', port: 0 });
const adminToken = crypto.randomUUID() + crypto.randomUUID();
const { app, store } = await createServer({ database: ':memory:', adminToken, origins: ['http://127.0.0.1:8787'], webRoot: resolve('dist/web') });
const server = await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 8787) });
const project = store.createProject('Demo workspace');
const device = store.createDevice(project.id, 'Demo computer');
const identity = await generateIdentity();
const agent = store.pair(device.pairingCode, identity.publicKey);
const client = store.createClient(project.id, device.id, 'Demo browser');
const stop = new AbortController();
const worker = runWorker({ server, token: agent.token, deviceId: device.id, identity, runtimeUrl: `${runtimeUrl}/v1`, models: ['demo-model'] }, stop.signal);
console.log(`\nSIMULATED DEMO · temporary in-memory database · no real LLM\n\nOpen ${server}/console/\nOwner key: ${project.ownerToken}\nModel: demo-model\n\nPaste this in Playground → Browser connection:\n${JSON.stringify({ server, token: client.token, deviceId: device.id, publicKey: identity.publicKey }, null, 2)}\n`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => { stop.abort(); await worker; await app.close(); await runtime.close(); });
