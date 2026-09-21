import type { FastifyInstance, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { plans } from '../../protocol/src/plans.js';
import { Fault, type Store } from './store.js';
import { termsVersion } from './accounts.js';
import { Billing, type BillingOptions } from './billing.js';
export interface SaasOptions {
  publicUrl: string; ownerEmails?: string[]; providerDisclosure?: string; sendLogin?: (email: string, link: string) => Promise<void>;
  operator: { name: string; address: string; email: string; taxId: string };
  billing?: BillingOptions; maxAccounts?: number; maxEmailsPerDay?: number;
}
export async function registerSaas(app: FastifyInstance, store: Store, options: SaasOptions) {
  const parsed = new URL(options.publicUrl);
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('PQ_PUBLIC_URL must be an HTTPS origin (HTTP is allowed on loopback only)');
  const origin = parsed.origin, secure = parsed.protocol === 'https:';
  const sessionName = secure ? '__Host-pq_session' : 'pq_session';
  const challengeName = secure ? '__Host-pq_challenge' : 'pq_challenge';
  const cookieOptions = { path: '/', secure, httpOnly: true, sameSite: 'lax' as const };
  const billing = options.billing ? new Billing(store.accounts, options.billing, origin) : undefined;
  await app.register(cookie);
  function sameOrigin(request: FastifyRequest) { if (request.headers.origin !== origin) throw new Fault('origin_rejected', 403); }
  function account(request: FastifyRequest) {
    if (!['GET', 'HEAD'].includes(request.method)) sameOrigin(request);
    return store.accounts.session(request.cookies[sessionName] ?? '');
  }
  const limit = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };
  const legalReady = Object.values(options.operator).every(value => Boolean(value.trim()));
  app.get('/v1/public', async () => ({ plans, operator: options.operator, termsVersion, providerDisclosure: options.providerDisclosure ?? '', signupEnabled: Boolean(options.sendLogin && legalReady), billingEnabled: Boolean(billing && legalReady) }));
  app.post('/v1/auth/request', limit, async (request, reply) => {
    sameOrigin(request);
    if (!options.sendLogin || !legalReady) throw new Fault('signup_not_configured', 503);
    const body = z.object({ email: z.email().max(254).transform(value => value.trim().toLowerCase()), acceptedTerms: z.boolean() }).strict().parse(request.body);
    const challenge = randomBytes(32).toString('base64url');
    const token = store.accounts.issue(body.email, challenge, body.acceptedTerms, options.maxAccounts, options.maxEmailsPerDay);
    await options.sendLogin(body.email, `${origin}/login/#token=${token}`);
    reply.setCookie(challengeName, challenge, { ...cookieOptions, maxAge: 900 });
    return reply.code(202).send({ ok: true });
  });
  app.post('/v1/auth/complete', limit, async (request, reply) => {
    sameOrigin(request);
    const { token } = z.object({ token: z.string().min(40).max(100) }).strict().parse(request.body);
    const session = store.accounts.consume(token, request.cookies[challengeName] ?? '', options.maxAccounts);
    reply.setCookie(sessionName, session, { ...cookieOptions, maxAge: 30 * 86400 });
    reply.clearCookie(challengeName, cookieOptions); return { ok: true };
  });
  app.post('/v1/auth/logout', async (request, reply) => {
    sameOrigin(request); store.accounts.logout(request.cookies[sessionName] ?? '');
    reply.clearCookie(sessionName, cookieOptions); return { ok: true };
  });
  app.post('/v1/auth/revoke-sessions', async request => { store.accounts.revokeSessions(account(request).id); return { ok: true }; });
  app.get('/v1/me', async request => {
    const user = account(request);
    return { email: user.email, plan: store.accounts.plan(user.project_id), usage: store.accounts.usage(user.project_id), paidUntil: user.paid_until, subscriptionStatus: user.subscription_status, cancelAtPeriodEnd: Boolean(user.cancel_at_period_end), hasBilling: Boolean(user.stripe_customer), billingEnabled: Boolean(billing && legalReady) };
  });
  app.get('/v1/account/export', async request => {
    const user = account(request);
    return { email: user.email, createdAt: user.created_at, termsVersion: user.terms_version, plan: store.accounts.plan(user.project_id), usage: store.accounts.usage(user.project_id), devices: store.devices(user.project_id), clients: store.clients(user.project_id) };
  });
  app.delete('/v1/account', async (request, reply) => {
    const user = account(request);
    z.object({ confirmation: z.literal('DELETE') }).strict().parse(request.body);
    if (user.stripe_customer && !billing) throw new Fault('billing_not_configured', 503);
    if (billing) await billing.deleteAccount(user.id); else store.accounts.delete(user.id);
    reply.clearCookie(sessionName, cookieOptions); return { ok: true };
  });
  app.post('/v1/billing/checkout', limit, async request => {
    const user = account(request);
    if (!billing || !legalReady) throw new Fault('billing_not_configured', 503);
    return { url: await billing.checkout(user.id) };
  });
  app.post('/v1/billing/portal', limit, async request => {
    const user = account(request);
    if (!billing) throw new Fault('billing_not_configured', 503);
    return { url: await billing.portal(user) };
  });
  if (billing) await app.register(async scope => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1_000_000 }, (_request, body, done) => done(null, body));
    scope.post('/v1/billing/webhook', async request => {
      const signature = request.headers['stripe-signature'];
      if (typeof signature !== 'string' || !Buffer.isBuffer(request.body)) throw new Fault('invalid_signature');
      await billing.webhook(request.body, signature); return { received: true };
    });
  });
  return { account };
}
