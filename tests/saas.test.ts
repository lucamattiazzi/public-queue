import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../packages/server/src/app.js';
const origin = 'https://queue.example.com';
test('email login, cookie CSRF boundary, customer project isolation and logout', async () => {
  let link = '';
  const { app } = await createServer({ database: ':memory:', adminToken: 'a'.repeat(40), saas: { publicUrl: origin, sendLogin: async (_email, url) => { link = url; }, operator: { name: 'Test operator', address: 'Test address', email: 'support@example.com', taxId: 'Test ID' } } });
  try {
    const request = await app.inject({ method: 'POST', url: '/v1/auth/request', headers: { origin }, payload: { email: 'hello@example.com', acceptedTerms: true } });
    assert.equal(request.statusCode, 202, request.body);
    const challenge = request.cookies[0]!;
    const token = new URL(link).hash.slice(7);
    assert.ok(token.length > 30);
    const finish = await app.inject({ method: 'POST', url: '/v1/auth/complete', headers: { origin, cookie: `${challenge.name}=${challenge.value}` }, payload: { token } });
    assert.equal(finish.statusCode, 200, finish.body);
    const session = finish.cookies.find(c => c.name.includes('session'))!;
    assert.equal(session.httpOnly, true); assert.equal(session.secure, true);
    const cookie = `${session.name}=${session.value}`;
    assert.equal((await app.inject({ url: '/v1/me', headers: { cookie } })).json().plan.id, 'free');
    const blocked = await app.inject({ method: 'POST', url: '/v1/devices', headers: { origin: 'https://evil.example', cookie }, payload: { name: 'wrong' } });
    assert.equal(blocked.statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/devices', headers: { origin, cookie }, payload: { name: 'home' } })).statusCode, 201);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/billing/checkout', headers: { origin, cookie }, payload: {} })).statusCode, 503);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { origin, cookie }, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ url: '/v1/me', headers: { cookie } })).statusCode, 401);
  } finally { await app.close(); }
});

test('webhook HTTP route preserves raw signed bytes and rejects tampering', async () => {
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe('sk_test_fixture');
  const { app } = await createServer({ database: ':memory:', adminToken: 'a'.repeat(40), saas: { publicUrl: origin, operator: { name: 'Test', address: 'Address', email: 'support@example.com', taxId: 'ID' }, billing: { secretKey: 'sk_test_fixture', webhookSecret: 'whsec_fixture', priceId: 'price_test' } } });
  try {
    const raw = JSON.stringify({ id: 'evt_http', type: 'invoice.paid', livemode: false, data: { object: { customer: 'cus_unrelated' } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload: raw, secret: 'whsec_fixture' });
    assert.equal((await app.inject({ method: 'POST', url: '/v1/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, payload: raw })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/billing/webhook', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, payload: raw + ' ' })).statusCode, 400);
  } finally { await app.close(); }
});
