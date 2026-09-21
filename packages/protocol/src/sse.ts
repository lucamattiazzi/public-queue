/** Bounded SSE reader. Handles split UTF-8, CR/LF/CRLF, comments and multiline data. */
export async function* readSSE(body: ReadableStream<Uint8Array>, maxBytes = 8_000_000): AsyncGenerator<string> {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', data: string[] = [], size = 0, eventSize = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (!chunk.done) { size += chunk.value.byteLength; if (size > maxBytes) throw new Error('SSE stream exceeds budget'); }
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      while (true) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0 || !chunk.done && index === buffer.length - 1 && buffer[index] === '\r') break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + (buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1));
        if (!line) { if (data.length) yield data.join('\n'); data = []; eventSize = 0; }
        else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, ''); eventSize += value.length;
          if (eventSize > 65536) throw new Error('SSE event exceeds budget'); data.push(value);
        }
      }
      if (buffer.length > 65536) throw new Error('SSE line exceeds budget');
      if (chunk.done) { if (buffer || data.length) throw new Error('Truncated SSE event'); return; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
