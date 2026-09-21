import * as z from 'zod/mini';

export const envelopeSchema = z.strictObject({
  version: z.literal(1), publicKey: z.string().check(z.minLength(80), z.maxLength(100)),
  iv: z.string().check(z.length(16)), ciphertext: z.string().check(z.minLength(20), z.maxLength(1_400_000)),
});
export type Envelope = z.infer<typeof envelopeSchema>;
export const payloadSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('encrypted'), data: envelopeSchema }),
  z.strictObject({ mode: z.literal('plain'), data: z.unknown() }),
]);
export type Payload = z.infer<typeof payloadSchema>;
export const chatSchema = z.strictObject({
  stream: z.optional(z.boolean()),
  model: z.string().check(z.minLength(1), z.maxLength(200)),
  messages: z.array(z.strictObject({ role: z.enum(['system', 'user', 'assistant']), content: z.string().check(z.maxLength(200_000)) })).check(z.minLength(1), z.maxLength(200)),
  temperature: z.optional(z.number().check(z.minimum(0), z.maximum(2))),
  max_tokens: z.optional(z.int().check(z.minimum(1), z.maximum(32768))),
});
export type ChatRequest = z.infer<typeof chatSchema>;
export const resultSchema = z.object({ text: z.string(), finishReason: z.nullable(z.string()) });
export type ChatResult = z.infer<typeof resultSchema>;
export const submitSchema = z.strictObject({
  id: z.uuid(), payload: payloadSchema, stream: z.optional(z.boolean()),
  ttlSeconds: z._default(z.int().check(z.minimum(60), z.maximum(604800)), 86400),
});
export type Submission = z.infer<typeof submitSchema>;
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
export interface Job {
  id: string; deviceId: string; stream?: boolean; status: JobStatus; attempts: number;
  createdAt: number; updatedAt: number; expiresAt: number;
  result: Payload | null; error: string | null;
}
export interface Assignment extends Job { payload: Payload; attemptId: string; leaseMs: number }
export interface Connection {
  server: string; token: string; deviceId: string; publicKey: string;
}
export const terminal = (status: JobStatus): boolean => !['queued', 'running'].includes(status);
export function requireSecureUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('URL must not contain credentials, query or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Use HTTPS (HTTP is allowed only on loopback for development)');
  }
  return url.href.replace(/\/$/, '');
}

export interface StreamBlock { sequence: number; payload: Payload }
export interface StreamPage { job: Job; attemptId: string | null; events: StreamBlock[]; hasMore: boolean }
export interface StreamCursor { attemptId: string | null; sequence: number }
export type StreamUpdate =
  | { type: 'reset'; attemptId: string; attempt: number; cursor: StreamCursor }
  | { type: 'delta'; text: string; cursor: StreamCursor }
  | { type: 'done'; result: ChatResult; cursor: StreamCursor };
