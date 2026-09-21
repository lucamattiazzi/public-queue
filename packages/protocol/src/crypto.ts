import type { Envelope } from './index.js';

export interface Identity { publicKey: string; privateKey: CryptoKey }
export type Context = { jobId: string; deviceId: string } & ({ direction: 'request' | 'response' } | { direction: 'chunk'; attemptId: string; sequence: number });
const encoder = new TextEncoder();
export function base64(bytes: Uint8Array): string {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
export async function importPublicKey(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', unbase64(value), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}
export async function generateIdentity(extractable = false): Promise<Identity> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, extractable, ['deriveBits']);
  return { publicKey: base64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), privateKey: pair.privateKey };
}
export async function restoreIdentity(publicKey: string, privateKey: JsonWebKey): Promise<Identity> {
  await importPublicKey(publicKey);
  const key = await crypto.subtle.importKey('jwk', privateKey, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  // Verify that the persisted public and private key refer to the same identity.
  const raw = new Uint8Array(65); raw[0] = 4;
  raw.set(unbase64(privateKey.x ?? ''), 1); raw.set(unbase64(privateKey.y ?? ''), 33);
  if (base64(raw) !== publicKey) throw new Error('Identity key mismatch');
  return { publicKey, privateKey: key };
}
function aad(context: Context): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(['public-queue', 1, context.deviceId, context.jobId, context.direction, ...(context.direction === 'chunk' ? [context.attemptId, context.sequence] : [])]));
}
async function derive(identity: Identity, peer: string, context: Context): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublicKey(peer) }, identity.privateKey, 256);
  const material = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(context.jobId), info: aad(context) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function seal(value: unknown, sender: Identity, recipient: string, context: Context): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(context) }, await derive(sender, recipient, context), encoder.encode(JSON.stringify(value)));
  return { version: 1, publicKey: sender.publicKey, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}
export async function open(envelope: Envelope, recipient: Identity, context: Context, expectedSender: string): Promise<unknown> {
  if (envelope.version !== 1 || envelope.publicKey !== expectedSender) throw new Error('Untrusted encryption identity');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(envelope.iv), additionalData: aad(context) }, await derive(recipient, expectedSender, context), unbase64(envelope.ciphertext));
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown;
}
export async function fingerprint(publicKey: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', unbase64(publicKey)));
  return Array.from(digest.slice(0, 16), b => b.toString(16).padStart(2, '0')).join(':');
}
