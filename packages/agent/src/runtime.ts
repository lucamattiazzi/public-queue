import { Agent, fetch } from 'undici';
import type { RequestInit } from 'undici';

// The job's AbortSignal owns the deadline, including slow headers and SSE gaps.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export function inferenceFetch(url: string, options: RequestInit & { signal: AbortSignal }) {
  return fetch(url, { ...options, dispatcher });
}
