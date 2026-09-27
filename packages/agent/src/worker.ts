import { readSSE } from '../../protocol/src/sse.js';
import { z } from 'zod';
import { chatSchema, requireSecureUrl } from '../../protocol/src/index.js';
import type { Assignment, ChatResult, Payload } from '../../protocol/src/index.js';
import { open, seal } from '../../protocol/src/crypto.js';
import type { Identity } from '../../protocol/src/crypto.js';
import { sleep } from '../../sdk/src/index.js';
import { inferenceFetch } from './runtime.js';
import type { Response as InferenceResponse } from 'undici';

export interface WorkerOptions {
  server: string; token: string; deviceId: string; identity: Identity;
  runtimeUrl: string; models: string[]; runtimeKey?: string; allowPlaintext?: boolean;
  pollMs?: number; timeoutMs?: number; onStatus?: (status: string) => void;
}
class HttpError extends Error { constructor(readonly status: number) { super(`HTTP ${status}`); } }
export async function agentRequest<T>(server: string, token: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${requireSecureUrl(server)}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) throw new HttpError(response.status);
  return response.json() as Promise<T>;
}
export function runtimeBase(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid runtime URL');
  return url.href.replace(/\/$/, '');
}
async function boundedJson(response: Response | InferenceResponse, maxBytes = 1_000_000): Promise<unknown> {
  if (!response.body) throw new Error('Empty inference response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength; if (total > maxBytes) throw new Error('Inference response exceeds 1 MB'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(data)) as unknown;
}
const completionSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }), finish_reason: z.string().nullable().optional() })).min(1) });
export async function discoverModels(url: string, runtimeKey?: string): Promise<string[]> {
  const response = await fetch(`${runtimeBase(url)}/models`, { headers: runtimeKey ? { Authorization: `Bearer ${runtimeKey}` } : {}, signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}`);
  return z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await boundedJson(response)).data.map(model => model.id);
}
export async function execute(job: Assignment, options: WorkerOptions, signal: AbortSignal): Promise<void> {
  const context = { jobId: job.id, deviceId: options.deviceId, direction: 'request' as const };
  const controller = new AbortController();
  const workSignal = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(options.timeoutMs ?? 600000)]);
  const heartbeatStop = new AbortController();
  let leaseLost = false;
  const heartbeat = (async () => {
    try {
      while (!heartbeatStop.signal.aborted) {
        await sleep(Math.max(100, Math.floor(job.leaseMs / 3)), heartbeatStop.signal);
        await agentRequest(options.server, options.token, `/v1/agent/jobs/${job.id}/heartbeat`, { attemptId: job.attemptId }, workSignal);
      }
    } catch {
      if (!heartbeatStop.signal.aborted) { leaseLost = true; controller.abort(new Error('Lease lost')); }
    }
  })();
  try {
    let result: ChatResult | { message: string }; let success = false;
    try {
      if (job.payload.mode === 'plain' && !options.allowPlaintext) throw new Error('Agent requires end-to-end encryption');
      const data = job.payload.mode === 'encrypted' ? await open(job.payload.data, options.identity, context, job.payload.data.publicKey) : job.payload.data;
      const request = chatSchema.parse(data);
      if (!options.models.includes(request.model)) throw new Error('Model is not allowed on this device');
      if (Boolean(request.stream) !== Boolean(job.stream)) throw new Error('Stream mode mismatch');
      const response = await inferenceFetch(`${runtimeBase(options.runtimeUrl)}/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(options.runtimeKey ? { Authorization: `Bearer ${options.runtimeKey}` } : {}) },
        body: JSON.stringify({ ...request, max_tokens: request.max_tokens ?? 2048, stream: Boolean(job.stream) }), signal: workSignal, redirect: 'error',
      });
      if (!response.ok) throw new Error(`Inference returned HTTP ${response.status}`);
      if (job.stream) result = await streamCompletion(response, job, options, workSignal);
      else {
        const completion = completionSchema.parse(await boundedJson(response));
        result = { text: completion.choices[0]!.message.content, finishReason: completion.choices[0]!.finish_reason ?? null };
      }
      success = true;
    } catch (error) {
      if (leaseLost || signal.aborted) return;
      // Do not forward arbitrary provider errors: they may contain prompts or credentials.
      result = { message: error instanceof Error && /^(Model is not allowed|Agent requires|Inference returned HTTP|Inference response exceeds)/.test(error.message) ? error.message : workSignal.aborted ? 'Inference timed out' : 'Inference failed; check runtime and request compatibility' };
    }
    if (leaseLost || signal.aborted) return;
    const payload: Payload = job.payload.mode === 'encrypted' ? { mode: 'encrypted', data: await seal(result, options.identity, job.payload.data.publicKey, { ...context, direction: 'response' }) } : { mode: 'plain', data: result };
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await agentRequest(options.server, options.token, `/v1/agent/jobs/${job.id}/finish`, { attemptId: job.attemptId, result: payload, success }, signal); return; }
      catch (error) {
        if (leaseLost || signal.aborted || error instanceof HttpError && error.status < 500) throw error;
        if (attempt === 2) throw error; await sleep(500 * 2 ** attempt, signal);
      }
    }
  } finally { heartbeatStop.abort(); await heartbeat; }
}
export async function runWorker(options: WorkerOptions, signal: AbortSignal): Promise<void> {
  requireSecureUrl(options.server); runtimeBase(options.runtimeUrl);
  if (!options.models.length) throw new Error('Select at least one allowed model');
  let failures = 0;
  while (!signal.aborted) {
    try {
      const { job } = await agentRequest<{ job: Assignment | null }>(options.server, options.token, '/v1/agent/claim', {}, signal);
      failures = 0;
      if (job) {
        options.onStatus?.(`Working on ${job.id}`);
        await execute(job, options, signal);
      } else await sleep(options.pollMs ?? 2500, signal);
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof HttpError && error.status === 401) throw new Error('Device access was revoked. Pair a new device.');
      options.onStatus?.('Connection interrupted; reconnecting automatically.');
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(++failures, 5)), signal).catch(() => {});
    }
  }
}

async function streamCompletion(response: InferenceResponse, job: Assignment, options: WorkerOptions, signal: AbortSignal): Promise<ChatResult> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Runtime did not provide SSE');
  let serializedBytes = 64;
  const encoder = new TextEncoder();
  let text = '', pending = '', sequence = 0, lastFlush = 0, finishReason: string | null = null, ended = false;
  const chunkSchema = z.object({ choices: z.array(z.object({ index: z.number().optional(), delta: z.object({ content: z.string().nullable().optional(), tool_calls: z.unknown().optional(), function_call: z.unknown().optional() }), finish_reason: z.string().nullable().optional() })) });
  async function flush() {
    while (pending) {
      let length = Math.min(2048, pending.length);
      if (length < pending.length && /[\uD800-\uDBFF]/.test(pending[length - 1]!)) length--;
      const delta = pending.slice(0, length); pending = pending.slice(length); sequence++;
      const payload: Payload = job.payload.mode === 'encrypted' ? { mode: 'encrypted', data: await seal({ text: delta }, options.identity, job.payload.data.publicKey, { jobId: job.id, deviceId: job.deviceId, direction: 'chunk', attemptId: job.attemptId, sequence }) } : { mode: 'plain', data: { text: delta } };
      // Reuse ciphertext and sequence on network retry; never encrypt a retry again.
      for (let retry = 0; ; retry++) {
        try { await agentRequest(options.server, options.token, `/v1/agent/jobs/${job.id}/blocks`, { attemptId: job.attemptId, sequence, payload }, signal); break; }
        catch (error) { if (signal.aborted || retry >= 2 || error instanceof HttpError && error.status < 500) throw error; await sleep(250 * 2 ** retry, signal); }
      }
    }
    lastFlush = Date.now();
  }
  for await (const data of readSSE(response.body)) {
    if (data === '[DONE]') { ended = true; break; }
    const chunk = chunkSchema.parse(JSON.parse(data));
    if (chunk.choices.length > 1) throw new Error('Multiple choices are unsupported');
    const choice = chunk.choices[0]; if (!choice) continue;
    if ((choice.index ?? 0) !== 0 || choice.delta.tool_calls || choice.delta.function_call) throw new Error('Unsupported stream content');
    const delta = choice.delta.content ?? '';
    if (finishReason && delta) throw new Error('Content after finish');
    text += delta; pending += delta;
    serializedBytes += encoder.encode(JSON.stringify(delta)).byteLength - 2;
    if (serializedBytes > 900000) throw new Error('Inference response exceeds streaming budget');
    if (pending && (pending.length >= 2048 || Date.now() - lastFlush >= 200)) await flush();
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (!ended || !finishReason) throw new Error('Truncated inference stream');
  await flush();
  return { text, finishReason };
}
