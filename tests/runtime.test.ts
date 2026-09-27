import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { inferenceFetch } from '../packages/agent/src/runtime.js';

// Undici exposes this clock specifically for tests; no five-minute wall-clock wait.
const timers = createRequire(import.meta.url)('undici/lib/util/timers.js') as { tick(ms: number): void };

for (const phase of ['headers', 'body'] as const) {
  test(`inference survives five minutes waiting for ${phase}, but still obeys cancellation`, async () => {
    const arrived = Promise.withResolvers<void>();
    const server = createServer((_request, response) => {
      if (phase === 'body') { response.writeHead(200); response.write('start'); }
      arrived.resolve();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const stop = new AbortController();
    let settled = false;
    let failure: unknown;
    const pending = inferenceFetch(`http://127.0.0.1:${address.port}`, { signal: stop.signal })
      .then(response => response.text()).catch(error => { failure = error; }).finally(() => { settled = true; });
    try {
      await arrived.promise;
      for (let i = 0; i < 5; i++) await setImmediate();
      timers.tick(1); timers.tick(301000);
      for (let i = 0; i < 5; i++) await setImmediate();
      assert.equal(settled, false, `inference ended early: ${String(failure)}`);
      const reason = new Error('Job deadline reached');
      stop.abort(reason);
      await pending;
      assert.equal(failure, reason);
    } finally {
      stop.abort(); await pending;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
