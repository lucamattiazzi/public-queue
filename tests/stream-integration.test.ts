import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { createServer } from '../packages/server/src/app.js';
import { generateIdentity, seal } from '../packages/protocol/src/crypto.js';
import { PublicQueue, MemoryIdentityStore, createOpenAIFetch, createUIMessageFetch } from '../packages/sdk/src/index.js';
import { runWorker } from '../packages/agent/src/worker.js';
import OpenAI from 'openai';
import { DefaultChatTransport } from 'ai';

async function fixture(leaseMs = 60000) {
  const service = await createServer({ database: ':memory:', leaseMs, adminToken: 'test-'.repeat(10) });
  const server = await service.app.listen({ host: '127.0.0.1', port: 0 });
  const runtime = Fastify(); let release = () => {}, hold = false, truncate = false, calls = 0;
  runtime.post('/v1/chat/completions', async (request, reply) => {
    calls++;
    const body = request.body as { stream: boolean };
    if (!body.stream) return { choices: [{ message: { content: 'hello world' }, finish_reason: 'stop' }] };
    const gate = hold ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
    return reply.type('text/event-stream').send(Readable.from((async function* () {
      yield `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hello ' }, finish_reason: null }] })}\n\n`;
      await gate;
      yield `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'world' }, finish_reason: null }] })}\n\n`;
      if (truncate) return;
      yield `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`;
      yield 'data: [DONE]\n\n';
    })()));
  });
  const runtimeUrl = await runtime.listen({ host: '127.0.0.1', port: 0 });
  const p = service.store.createProject('stream'), d = service.store.createDevice(p.id, 'home');
  const identity = await generateIdentity();
  const agent = service.store.pair(d.pairingCode, identity.publicKey), client = service.store.createClient(p.id, d.id, 'browser');
  const queue = new PublicQueue({ server, token: client.token, deviceId: d.id, publicKey: identity.publicKey, identityStore: new MemoryIdentityStore(), pollMs: 15 });
  const stop = new AbortController();
  const worker = runWorker({ server, token: agent.token, deviceId: d.id, identity, runtimeUrl: `${runtimeUrl}/v1`, models: ['test'], pollMs: 10 }, stop.signal);
  return { queue, service, client, identity, device: d, stopWorker: async () => { stop.abort(); await worker; }, calls: () => calls, hold: () => { hold = true; }, truncate: () => { truncate = true; }, release: () => release(), async close() { release(); stop.abort(); await worker; await runtime.close(); await service.app.close(); } };
}

test('encrypted progressive output arrives before completion and resumes without repeating blocks', { timeout: 10000 }, async () => {
  const f = await fixture(); f.hold();
  try {
    const job = await f.queue.submit({ model: 'test', stream: true, messages: [{ role: 'user', content: 'PRIVATE PROMPT' }] });
    const stream = f.queue.stream(job.id);
    assert.equal((await stream.next()).value?.type, 'reset');
    const first = (await stream.next()).value!;
    assert.equal(first.type, 'delta'); if (first.type !== 'delta') throw new Error('Expected delta');
    assert.equal(first.text, 'hello ');
    assert.equal((await f.queue.get(job.id)).status, 'running');
    const stored = f.service.store.events(f.client.id, job.id, null, 0);
    assert.equal(stored.events[0]?.payload.mode, 'encrypted'); assert.equal(JSON.stringify(stored).includes('hello'), false);
    await stream.return(undefined);
    f.release();
    let remainder = '', result = '';
    for await (const update of f.queue.stream(job.id, { cursor: first.cursor })) {
      if (update.type === 'delta') remainder += update.text;
      if (update.type === 'done') result = update.result.text;
    }
    assert.equal(remainder, 'world'); assert.equal(result, 'hello world'); assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});

test('official OpenAI SDK uses encrypted fetch adapter for streaming, JSON and replay', { timeout: 10000 }, async () => {
  const f = await fixture(); let jobId = '';
  try {
    const client = new OpenAI({ apiKey: 'unused-local-placeholder', baseURL: 'https://public-queue.invalid/v1', maxRetries: 0, fetch: createOpenAIFetch(f.queue, { onJob: job => { jobId = job.id; } }) });
    let text = '';
    for await (const part of await client.chat.completions.create({ model: 'test', stream: true, messages: [{ role: 'user', content: 'hi' }] })) text += part.choices[0]?.delta.content ?? '';
    assert.equal(text, 'hello world'); assert.ok(jobId);
    const replay = new OpenAI({ apiKey: 'unused', baseURL: 'https://public-queue.invalid/v1', maxRetries: 0, fetch: createOpenAIFetch(f.queue, { resumeJobId: jobId }) });
    assert.equal((await replay.chat.completions.create({ model: 'test', messages: [{ role: 'user', content: 'ignored in explicit replay mode' }] })).choices[0]?.message.content, text);
    assert.equal(f.calls(), 1);
    assert.equal((await client.chat.completions.create({ model: 'test', messages: [{ role: 'user', content: 'hi' }] })).choices[0]?.message.content, text);
  } finally { await f.close(); }
});

test('real AI SDK DefaultChatTransport accepts the encrypted UI message stream', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const transport = new DefaultChatTransport({ fetch: createUIMessageFetch(f.queue, { model: 'test' }) });
    const stream = await transport.sendMessages({ trigger: 'submit-message', chatId: 'chat', messageId: undefined, abortSignal: undefined, messages: [{ id: 'message', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] });
    let text = '', finished = false;
    const reader = stream.getReader();
    try { while (true) { const next = await reader.read(); if (next.done) break; const part = next.value; if (part.type === 'text-delta') text += part.delta; if (part.type === 'finish') finished = true; assert.notEqual(part.type, 'error'); } } finally { reader.releaseLock(); }
    assert.equal(text, 'hello world'); assert.equal(finished, true);
    const unsupported = await createOpenAIFetch(f.queue)('https://unused/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'test', messages: [], tools: [] }) });
    assert.equal(unsupported.status, 400);
  } finally { await f.close(); }
});


test('adapter fails rather than concatenating different inference attempts; native stream resets', { timeout: 10000 }, async () => {
  const f = await fixture(150); await f.stopWorker();
  let id = '';
  const controller = new AbortController();
  try {
    const client = new OpenAI({ apiKey: 'unused', baseURL: 'https://public-queue.invalid/v1', maxRetries: 0, fetch: createOpenAIFetch(f.queue, { onJob: job => { id = job.id; } }) });
    const response = await client.chat.completions.create({ model: 'test', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { signal: controller.signal });
    const first = f.service.store.claim(f.device.id)!;
    if (first.payload.mode !== 'encrypted') throw new Error('Expected encrypted');
    const recipient = first.payload.data.publicKey;
    async function append(attemptId: string, text: string) {
      const payload = { mode: 'encrypted' as const, data: await seal({ text }, f.identity, recipient, { jobId: id, deviceId: f.device.id, direction: 'chunk', attemptId, sequence: 1 }) };
      f.service.store.append(f.device.id, id, attemptId, 1, payload);
    }
    await append(first.attemptId, 'first');
    const iterator = response[Symbol.asyncIterator]();
    await iterator.next(); // assistant role
    assert.equal((await iterator.next()).value?.choices[0]?.delta.content, 'first');
    const native = f.queue.stream(id);
    await native.next(); assert.equal((await native.next()).value?.type, 'delta');
    await new Promise(resolve => setTimeout(resolve, 170));
    const second = f.service.store.claim(f.device.id)!;
    assert.ok(second); await append(second.attemptId, 'second');
    f.service.store.finish(f.device.id, id, second.attemptId, { mode: 'encrypted', data: await seal({ text: 'second', finishReason: 'stop' }, f.identity, recipient, { jobId: id, deviceId: f.device.id, direction: 'response' }) }, true);
    await assert.rejects(iterator.next(), /inference_restarted_resume_job/);
    assert.equal((await native.next()).value?.type, 'reset');
    const delta = (await native.next()).value;
    assert.equal(delta?.type, 'delta'); if (delta?.type === 'delta') assert.equal(delta.text, 'second');
    await native.return(undefined);
    assert.equal((await f.queue.wait(id)).text, 'second');
  } finally { controller.abort(); await f.close(); }
});

test('aborting SDK observation does not cancel the durable job', { timeout: 10000 }, async () => {
  const f = await fixture(); f.hold(); const controller = new AbortController(); let id = '';
  try {
    const client = new OpenAI({ apiKey: 'unused', baseURL: 'https://public-queue.invalid/v1', maxRetries: 0, fetch: createOpenAIFetch(f.queue, { onJob: job => { id = job.id; } }) });
    const response = await client.chat.completions.create({ model: 'test', stream: true, messages: [{ role: 'user', content: 'hi' }] }, { signal: controller.signal });
    const iterator = response[Symbol.asyncIterator](); await iterator.next();
    assert.equal((await iterator.next()).value?.choices[0]?.delta.content, 'hello ');
    controller.abort();
    await iterator.next().catch(() => {});
    assert.equal((await f.queue.get(id)).status, 'running');
    f.release(); assert.equal((await f.queue.wait(id)).text, 'hello world'); assert.equal(f.calls(), 1);
  } finally { controller.abort(); await f.close(); }
});


test('truncated runtime stream is failed rather than saved as a successful partial result', { timeout: 10000 }, async () => {
  const f = await fixture(); f.truncate();
  try {
    const job = await f.queue.submit({ model: 'test', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    await assert.rejects(f.queue.wait(job.id), /Inference failed/);
    assert.equal((await f.queue.get(job.id)).status, 'failed');
  } finally { await f.close(); }
});

test('adapter preserves queue authorization errors as HTTP errors for the caller SDK', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const job = await f.queue.submit({ model: 'test', messages: [{ role: 'user', content: 'hi' }] });
    const ownerProject = f.service.store.client(f.client.token).project_id;
    f.service.store.revoke(ownerProject, f.client.id, 'client');
    const response = await createOpenAIFetch(f.queue, { resumeJobId: job.id })('https://public-queue.invalid/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(response.status, 401); assert.equal((await response.json() as { error: { code: string } }).error.code, 'unauthorized');
  } finally { await f.close(); }
});
