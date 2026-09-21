import * as z from 'zod/mini';
import { chatSchema } from '../../protocol/src/index.js';
import type { ChatRequest, Job, ChatResult } from '../../protocol/src/index.js';
import { PublicQueue, QueueError } from './index.js';

export interface AdapterOptions {
  /** Persist this job ID to recover after tab closure. Callback runs after durable acceptance. */
  onJob?: (job: Job) => void | Promise<void>;
  onStatus?: (job: Job) => void;
  /** Explicitly replay an existing job instead of submitting the supplied messages. */
  resumeJobId?: string;
}
export interface UIAdapterOptions extends AdapterOptions { model: string; temperature?: number; max_tokens?: number }
type Fetch = typeof globalThis.fetch;
const uiSchema = z.strictObject({
  id: z.optional(z.string()), trigger: z.optional(z.enum(['submit-message', 'regenerate-message'])), messageId: z.optional(z.string()),
  messages: z.array(z.strictObject({
    id: z.string(), role: z.enum(['system', 'user', 'assistant']), metadata: z.optional(z.unknown()),
    parts: z.array(z.strictObject({ type: z.literal('text'), text: z.string(), state: z.optional(z.enum(['streaming', 'done'])) })),
  })),
});
function failure(code: string, status = 400): Response { return Response.json({ error: { message: code, type: 'public_queue_error', code } }, { status }); }
function code(error: unknown): string { return error instanceof QueueError ? error.code : 'stream_failed'; }
async function readBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error('Missing body');
  const reader = request.body.getReader(); let bytes = 0, text = ''; const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 1_500_000) throw new Error('Body too large'); text += decoder.decode(part.value, { stream: true }); }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function completion(id: string, model: string, result: ChatResult) {
  return { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: result.finishReason }] };
}
function streamResponse(queue: PublicQueue, job: Job, model: string, ui: boolean, signal: AbortSignal, options: AdapterOptions): Response {
  const stop = new AbortController(), combined = AbortSignal.any([signal, stop.signal]);
  const encoder = new TextEncoder(), messageId = `pq-${job.id}`, textId = `${messageId}-text`;
  async function* events(): AsyncGenerator<unknown> {
    if (ui) { yield { type: 'start', messageId }; yield { type: 'text-start', id: textId }; }
    const chunk = (text: string, finish: string | null = null) => ({ id: job.id, object: 'chat.completion.chunk', created: Math.floor(job.createdAt / 1000), model, choices: [{ index: 0, delta: finish === null ? { content: text } : {}, finish_reason: finish }] });
    if (!ui) yield { ...chunk(''), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
    let text = '', attempt: string | null = null;
    try {
      for await (const update of queue.stream(job.id, { signal: combined, ...(options.onStatus ? { onUpdate: options.onStatus } : {}) })) {
        if (update.type === 'reset') {
          if (attempt !== null && attempt !== update.attemptId && text) throw new QueueError('inference_restarted_resume_job', 409);
          attempt = update.attemptId;
        } else if (update.type === 'delta') {
          text += update.text;
          yield ui ? { type: 'text-delta', id: textId, delta: update.text } : chunk(update.text);
        } else {
          if (!update.result.text.startsWith(text)) throw new QueueError('stream_result_mismatch', 409);
          const tail = update.result.text.slice(text.length);
          if (tail) yield ui ? { type: 'text-delta', id: textId, delta: tail } : chunk(tail);
          if (ui) { yield { type: 'text-end', id: textId }; yield { type: 'finish', finishReason: update.result.finishReason === 'content_filter' ? 'content-filter' : ['stop', 'length', 'error', 'other'].includes(update.result.finishReason ?? '') ? update.result.finishReason : 'other' }; }
          else yield chunk('', update.result.finishReason ?? 'stop');
        }
      }
    } catch (error) {
      if (combined.aborted) throw error;
      yield ui ? { type: 'error', errorText: code(error) } : { error: { message: code(error), type: 'public_queue_error', code: code(error) } };
    }
  }
  const iterator = events(); let ended = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        combined.throwIfAborted(); const next = await iterator.next(); combined.throwIfAborted();
        if (next.done) { if (!ended) controller.enqueue(encoder.encode('data: [DONE]\n\n')); ended = true; controller.close(); }
        else controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
      } catch (error) { controller.error(error); }
    },
    async cancel() { stop.abort(); await iterator.return(undefined); },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'x-public-queue-job-id': job.id, ...(ui ? { 'x-vercel-ai-ui-message-stream': 'v1' } : {}) } });
}
/** OpenAI Chat Completions text subset. No network calls go to the intercepted URL. */
export function createOpenAIFetch(queue: PublicQueue, options: AdapterOptions = {}): Fetch {
  return adapter(queue, options);
}
/** Plug into new DefaultChatTransport({ fetch: createUIMessageFetch(queue, { model }) }). */
export function createUIMessageFetch(queue: PublicQueue, options: UIAdapterOptions): Fetch {
  return adapter(queue, options, options);
}
function adapter(queue: PublicQueue, options: AdapterOptions, ui?: UIAdapterOptions): Fetch {
  return async (input, init) => {
    const target = typeof input === 'string' && input.startsWith('/') ? new URL(input, 'https://public-queue.invalid').href : input;
    const request = new Request(target, init);
    if (request.method !== 'POST' || !ui && !new URL(request.url).pathname.endsWith('/chat/completions')) return failure('unsupported_endpoint');
    let chat: ChatRequest;
    try {
      const body = await readBody(request);
      if (ui) {
        const parsed = uiSchema.parse(body);
        chat = chatSchema.parse({ model: ui.model, stream: true, messages: parsed.messages.map(message => ({ role: message.role, content: message.parts.map(part => part.text).join('') })), ...(ui.temperature === undefined ? {} : { temperature: ui.temperature }), ...(ui.max_tokens === undefined ? {} : { max_tokens: ui.max_tokens }) });
      } else chat = chatSchema.parse(body);
    } catch { return failure('unsupported_request_use_text_messages_only'); }
    try {
      const job = options.resumeJobId ? await queue.get(options.resumeJobId, request.signal) : await queue.submit(chat, { signal: request.signal });
      await options.onJob?.(job);
      if (chat.stream) return streamResponse(queue, job, chat.model, Boolean(ui), request.signal, options);
      const result = await queue.wait(job.id, { signal: request.signal, ...(options.onStatus ? { onUpdate: options.onStatus } : {}) });
      return Response.json(completion(job.id, chat.model, result), { headers: { 'x-public-queue-job-id': job.id, 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (error instanceof QueueError) return failure(error.code, error.status);
      throw error;
    }
  };
}
