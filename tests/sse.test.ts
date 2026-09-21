import test from 'node:test';
import assert from 'node:assert/strict';
import { readSSE } from '../packages/protocol/src/sse.js';
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> { const result: T[] = []; for await (const item of items) result.push(item); return result; }
test('SSE handles byte-split unicode, CRLF, comments and multiple data lines', async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\ndata: hé🙂\r\ndata: world\r\n\r\ndata: [DONE]\n\n');
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  assert.deepEqual(await collect(readSSE(stream)), ['hé🙂\nworld', '[DONE]']);
});
test('SSE fails on truncated events and excessive input', async () => {
  await assert.rejects(collect(readSSE(new Response('data: unfinished').body!)), /Truncated/);
  await assert.rejects(collect(readSSE(new Response('data: long\n\n').body!, 3)), /budget/);
});
