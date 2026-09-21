import test from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, seal, open } from '../packages/protocol/src/crypto.js';

test('only recipient can decrypt; job, direction and sender are authenticated', async () => {
  const browser = await generateIdentity();
  const agent = await generateIdentity();
  const stranger = await generateIdentity();
  const context = { jobId: crypto.randomUUID(), deviceId: 'device', direction: 'request' as const };
  const body = { model: 'private-model', messages: [{ role: 'user', content: 'PRIVATE PROMPT' }] };
  const encrypted = await seal(body, browser, agent.publicKey, context);
  assert.equal(JSON.stringify(encrypted).includes('PRIVATE'), false);
  assert.deepEqual(await open(encrypted, agent, context, browser.publicKey), body);
  await assert.rejects(open(encrypted, stranger, context, browser.publicKey));
  await assert.rejects(open(encrypted, agent, { ...context, jobId: 'different' }, browser.publicKey));
  await assert.rejects(open(encrypted, agent, { ...context, direction: 'response' }, browser.publicKey));
  await assert.rejects(open(encrypted, agent, context, stranger.publicKey));
  const response = await seal({ text: 'PRIVATE RESPONSE' }, agent, browser.publicKey, { ...context, direction: 'response' });
  assert.deepEqual(await open(response, browser, { ...context, direction: 'response' }, agent.publicKey), { text: 'PRIVATE RESPONSE' });
});

test('stream ciphertext authenticates both attempt and sequence', async () => {
  const { generateIdentity, seal, open } = await import('../packages/protocol/src/crypto.js');
  const sender = await generateIdentity(), recipient = await generateIdentity();
  const context = { jobId: crypto.randomUUID(), deviceId: crypto.randomUUID(), direction: 'chunk' as const, attemptId: crypto.randomUUID(), sequence: 1 };
  const envelope = await seal({ text: 'private delta' }, sender, recipient.publicKey, context);
  assert.deepEqual(await open(envelope, recipient, context, sender.publicKey), { text: 'private delta' });
  await assert.rejects(open(envelope, recipient, { ...context, sequence: 2 }, sender.publicKey));
  await assert.rejects(open(envelope, recipient, { ...context, attemptId: crypto.randomUUID() }, sender.publicKey));
});
