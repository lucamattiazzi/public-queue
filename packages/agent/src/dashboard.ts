import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgentQueue } from '../../protocol/src/index.js';
import { dashboardHtml, dashboardCss, dashboardScript } from './dashboard-page.js';

interface DashboardOptions {
  server: string; deviceId: string; runtimeUrl: string; models: string[];
  consuming: boolean;
  loadQueue: () => Promise<AgentQueue>;
}
export async function startDashboard(options: DashboardOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  let origin = '';
  let pending: Promise<AgentQueue> | undefined;
  let cached: { value: AgentQueue; until: number } | undefined;
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status: number, data: string, type = 'application/json') => {
      response.writeHead(status, { 'Content-Type': `${type}; charset=utf-8` }); response.end(data);
    };
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) { send(403, '{"error":"forbidden"}'); return; }
    if (request.method !== 'GET') { send(405, '{"error":"method_not_allowed"}'); return; }
    const path = request.url;
    if (path === '/') { send(200, dashboardHtml, 'text/html'); return; }
    if (path === '/dashboard.css') { send(200, dashboardCss, 'text/css'); return; }
    if (path === '/dashboard.js') { send(200, dashboardScript, 'text/javascript'); return; }
    if (path !== '/api/status') { send(404, '{"error":"not_found"}'); return; }
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { send(401, '{"error":"unauthorized"}'); return; }
    try {
      if (!cached || cached.until < Date.now()) {
        pending ??= options.loadQueue();
        try { cached = { value: await pending, until: Date.now() + 2000 }; } finally { pending = undefined; }
      }
      send(200, JSON.stringify({ server: options.server, deviceId: options.deviceId, runtimeUrl: options.runtimeUrl, models: options.models, consuming: options.consuming, queue: cached.value, checkedAt: Date.now() }));
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      const message = status === 404 ? 'Update your relay to a version with the agent queue API.' : status === 401 ? 'Device access is no longer valid. Pair this device again.' : 'Cannot reach the relay. Check your connection; jobs shown below may be outdated.';
      send(503, JSON.stringify({ error: message }));
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Local dashboard failed to listen')); return; }
      origin = `http://127.0.0.1:${address.port}`; resolve();
    });
  });
  return { url: `${origin}/#${token}`, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
