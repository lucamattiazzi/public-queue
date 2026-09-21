import { chatSchema, requireSecureUrl, resultSchema, terminal } from '../../protocol/src/index.js';
import type { ChatRequest, ChatResult, Connection, Job, Payload, StreamCursor, StreamPage, StreamUpdate } from '../../protocol/src/index.js';
import { generateIdentity, open, seal } from '../../protocol/src/crypto.js';
import type { Identity } from '../../protocol/src/crypto.js';
export type { ChatRequest, ChatResult, Connection, Job, StreamCursor, StreamPage, StreamUpdate } from '../../protocol/src/index.js';
export { fingerprint } from '../../protocol/src/crypto.js';

export class QueueError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); this.name = 'QueueError'; }
}
export interface IdentityStore { get(scope: string): Promise<Identity | undefined>; set(scope: string, identity: Identity): Promise<void> }
export class MemoryIdentityStore implements IdentityStore {
  private identities = new Map<string, Identity>();
  async get(scope: string): Promise<Identity | undefined> { return this.identities.get(scope); }
  async set(scope: string, identity: Identity): Promise<void> { this.identities.set(scope, identity); }
}
/** Browser keys are non-extractable CryptoKeys, persisted locally; never sent to the service. */
export class BrowserIdentityStore implements IdentityStore {
  private async database(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('public-queue-keys', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('keys'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async get(scope: string): Promise<Identity | undefined> {
    const db = await this.database();
    try { return await new Promise((resolve, reject) => {
      const request = db.transaction('keys').objectStore('keys').get(scope);
      request.onsuccess = () => resolve(request.result as Identity | undefined);
      request.onerror = () => reject(request.error);
    }); } finally { db.close(); }
  }
  async set(scope: string, identity: Identity): Promise<void> {
    const db = await this.database();
    try { await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('keys', 'readwrite');
      const keys = transaction.objectStore('keys');
      const existing = keys.get(scope);
      existing.onsuccess = () => { if (!existing.result) keys.put(identity, scope); };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error('Key storage aborted'));
    }); } finally { db.close(); }
  }
}
interface ClientOptions extends Connection { identityStore?: IdentityStore; encrypted?: boolean; pollMs?: number }
export class PublicQueue {
  private readonly server: string;
  private readonly encrypted: boolean;
  private readonly identities: IdentityStore;
  private identityPromise: Promise<Identity> | undefined;
  constructor(private readonly options: ClientOptions) {
    this.server = requireSecureUrl(options.server);
    this.encrypted = options.encrypted ?? true;
    this.identities = options.identityStore ?? (typeof indexedDB === 'undefined' ? new MemoryIdentityStore() : new BrowserIdentityStore());
    if (this.encrypted && !options.publicKey) throw new Error('Pin the device public key copied from your agent');
  }
  private identity(): Promise<Identity> {
    this.identityPromise ??= (async () => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.options.token));
      const scope = `${this.server}:${this.options.deviceId}:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
      const stored = await this.identities.get(scope);
      if (stored) return stored;
      const identity = await generateIdentity(); await this.identities.set(scope, identity);
      return await this.identities.get(scope) ?? identity;
    })();
    return this.identityPromise;
  }
  private async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${this.server}${path}`, {
          method, headers: { Authorization: `Bearer ${this.options.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
          credentials: 'omit', redirect: 'error',
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          throw new QueueError(data.error ?? 'request_failed', response.status);
        }
        return await response.json() as T;
      } catch (error) {
        const transient = error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError' || error instanceof QueueError && error.status >= 500;
        if (method !== 'GET' || attempt >= 2 || signal?.aborted || !transient) throw error;
        await sleep(200 * 2 ** attempt, signal);
      }
    }
  }
  /** Returns only after durable acceptance. Retries reuse the exact encrypted request and job ID. */
  async submit(input: ChatRequest, options: { id?: string; ttlSeconds?: number; signal?: AbortSignal } = {}): Promise<Job> {
    const data = chatSchema.parse(input);
    const id = options.id ?? crypto.randomUUID();
    const payload: Payload = this.encrypted ? { mode: 'encrypted', data: await seal(data, await this.identity(), this.options.publicKey, { jobId: id, deviceId: this.options.deviceId, direction: 'request' }) } : { mode: 'plain', data };
    for (let attempt = 0; ; attempt++) {
      try { return await this.request<Job>('/v1/jobs', 'POST', { id, payload, ttlSeconds: options.ttlSeconds ?? 86400, ...(data.stream ? { stream: true } : {}) }, options.signal); }
      catch (error) {
        if (attempt >= 2 || options.signal?.aborted || (error instanceof QueueError && error.status < 500)) throw error;
        await sleep(300 * 2 ** attempt, options.signal);
      }
    }
  }
  get(id: string, signal?: AbortSignal): Promise<Job> { return this.request(`/v1/jobs/${encodeURIComponent(id)}`, 'GET', undefined, signal); }
  list(signal?: AbortSignal): Promise<Job[]> { return this.request('/v1/jobs', 'GET', undefined, signal); }
  cancel(id: string): Promise<Job> { return this.request(`/v1/jobs/${encodeURIComponent(id)}`, 'DELETE'); }
  async result(job: Job): Promise<ChatResult> {
    if (!terminal(job.status)) throw new QueueError('job_not_finished', 409);
    if (!job.result) throw new QueueError(job.error ?? job.status, 409);
    if (this.encrypted && job.result.mode !== 'encrypted') throw new Error('Refusing plaintext result for an encrypted client');
    const value = job.result.mode === 'encrypted' ? await open(job.result.data, await this.identity(), { jobId: job.id, deviceId: this.options.deviceId, direction: 'response' }, this.options.publicKey) : job.result.data;
    if (job.status !== 'succeeded') throw new QueueError(typeof value === 'object' && value && 'message' in value ? String(value.message) : 'inference_failed', 422);
    return resultSchema.parse(value);
  }
  /** Durable encrypted stream. Aborting observation leaves the job alive; cancel explicitly. */
  async *stream(id: string, options: { signal?: AbortSignal; cursor?: StreamCursor; onUpdate?: (job: Job) => void } = {}): AsyncGenerator<StreamUpdate> {
    let cursor: StreamCursor = { ...(options.cursor ?? { attemptId: null, sequence: 0 }) }, failures = 0;
    while (true) {
      const query = new URLSearchParams({ after: String(cursor.sequence) });
      if (cursor.attemptId) query.set('attemptId', cursor.attemptId);
      let page: StreamPage;
      try { page = await this.request(`/v1/jobs/${encodeURIComponent(id)}/events?${query}`, 'GET', undefined, options.signal); failures = 0; }
      catch (error) {
        if (options.signal?.aborted || error instanceof QueueError && error.status < 500 && error.status !== 429 || ++failures > 5) throw error;
        await sleep(Math.min(30000, 500 * 2 ** failures), options.signal); continue;
      }
      options.onUpdate?.(page.job);
      if (page.attemptId && page.attemptId !== cursor.attemptId) {
        cursor = { attemptId: page.attemptId, sequence: 0 };
        yield { type: 'reset', attemptId: page.attemptId, attempt: page.job.attempts, cursor: { ...cursor } };
      }
      for (const block of page.events) {
        if (!page.attemptId || block.sequence !== cursor.sequence + 1) throw new QueueError('stream_sequence', 409);
        if (this.encrypted && block.payload.mode !== 'encrypted') throw new Error('Refusing plaintext stream');
        const value = block.payload.mode === 'encrypted' ? await open(block.payload.data, await this.identity(), { jobId: id, deviceId: this.options.deviceId, direction: 'chunk', attemptId: page.attemptId, sequence: block.sequence }, this.options.publicKey) : block.payload.data;
        if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string') throw new Error('Invalid stream block');
        cursor = { attemptId: page.attemptId, sequence: block.sequence };
        yield { type: 'delta', text: value.text, cursor: { ...cursor } };
      }
      if (page.hasMore) continue;
      if (terminal(page.job.status)) { yield { type: 'done', result: await this.result(page.job), cursor: { ...cursor } }; return; }
      await sleep(this.options.pollMs ?? 500, options.signal);
    }
  }
  async wait(id: string, options: { signal?: AbortSignal; onUpdate?: (job: Job) => void } = {}): Promise<ChatResult> {
    let failures = 0;
    while (true) {
      let job: Job;
      try { job = await this.get(id, options.signal); failures = 0; }
      catch (error) {
        if (options.signal?.aborted || (error instanceof QueueError && error.status < 500 && error.status !== 429) || ++failures > 5) throw error;
        await sleep(Math.min(30000, 1000 * 2 ** failures), options.signal); continue;
      }
      options.onUpdate?.(job);
      if (terminal(job.status)) return this.result(job);
      await sleep(this.options.pollMs ?? 2000, options.signal);
    }
  }
}
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const cancel = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
export { createOpenAIFetch, createUIMessageFetch } from './adapters.js';
export type { AdapterOptions, UIAdapterOptions } from './adapters.js';
