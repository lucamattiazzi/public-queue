import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/server/src/store.js';
import { Billing } from '../packages/server/src/billing.js';
import { createServer } from '../packages/server/src/app.js';
import { saasFromEnv } from '../packages/server/src/config.js';

test('verified owner bypasses commercial quotas and Stripe cannot remove exemption', async () => {
  let now = Date.UTC(2026, 8, 20);
  const store = new Store(':memory:', { clock: () => now, ownerEmails: ['OWNER@example.com'], dailyLimit: 1, pendingLimit: 1, storageLimitBytes: 1 });
  try {
    const session = store.accounts.consume(store.accounts.issue('owner@example.com', 'browser', true), 'browser');
    const owner = store.accounts.session(session);
    assert.equal(store.accounts.plan(owner.project_id)?.id, 'owner');
    const devices = Array.from({ length: 12 }, (_, i) => store.createDevice(owner.project_id, `device ${i}`));
    const device = devices[11]!;
    store.pair(device.pairingCode, 'key');
    const clients = Array.from({ length: 102 }, (_, i) => store.createClient(owner.project_id, device.id, `client ${i}`));
    const client = clients[101]!;
    const jobs = Array.from({ length: 105 }, () => store.submit(client.id, { id: crypto.randomUUID(), ttlSeconds: 60, payload: { mode: 'encrypted', data: { version: 1, publicKey: 'key', iv: 'iv', ciphertext: 'cipher' } } }));
    assert.equal(store.accounts.usage(owner.project_id).pending, 105);
    assert.ok(store.claim(device.id));
    store.accounts.setCustomer(owner.id, 'cus_owner');
    store.accounts.applyBilling('evt_owner_cancel', 'cus_owner', { id: 'sub_owner', status: 'canceled', paidUntil: 0, cancelAtPeriodEnd: false });
    now += 90 * 86400_000;
    store.sweep();
    assert.equal(store.accounts.plan(owner.project_id)?.id, 'owner');
    assert.equal(store.getJob(client.id, jobs[0]!.id).status, 'expired');
    now += 90 * 86400_000;
    store.sweep();
    assert.equal(store.getJob(client.id, jobs[0]!.id).status, 'expired');
    const billing = new Billing(store.accounts, { secretKey: 'sk_test_fixture', priceId: 'price_fixture', webhookSecret: 'whsec_fixture' }, 'https://queue.example.com');
    await assert.rejects(billing.checkout(owner.id), /owner_does_not_need_subscription/);
    const regular = store.accounts.session(store.accounts.consume(store.accounts.issue('other@example.com', 'other', true), 'other'));
    assert.equal(store.accounts.plan(regular.project_id)?.id, 'free');
    store.createDevice(regular.project_id, 'first');
    assert.throws(() => store.createDevice(regular.project_id, 'second'), /device_limit/);
  } finally { store.close(); }
});

test('owner API presents null quotas and does not expose the private email allowlist', async () => {
  const origin = 'https://queue.example.com';
  const { app, store } = await createServer({ database: ':memory:', adminToken: 'a'.repeat(40), saas: { publicUrl: origin, sendLogin: async () => {}, ownerEmails: ['owner@example.com'], operator: { name: 'Operator', address: 'Address', taxId: 'ID', email: 'support@example.com' } } });
  try {
    const session = store.accounts.consume(store.accounts.issue('owner@example.com', 'b', true), 'b');
    const me = await app.inject({ url: '/v1/me', headers: { cookie: `__Host-pq_session=${session}` } });
    assert.equal(me.json().plan.id, 'owner'); assert.equal(me.json().plan.monthlyJobs, null); assert.equal(me.json().plan.retentionDays, null);
    const publicConfig = await app.inject('/v1/public');
    assert.equal(publicConfig.body.includes('owner@example.com'), false); assert.equal(publicConfig.json().plans.owner, undefined);
    const forged = await app.inject({ method: 'POST', url: '/v1/auth/request', headers: { origin }, payload: { email: 'other@example.com', acceptedTerms: true, plan: 'owner' } });
    assert.equal(forged.statusCode, 400);
  } finally { await app.close(); }
});

test('owner email configuration rejects wildcards and normalizes exact addresses', () => {
  assert.throws(() => saasFromEnv({ PQ_PUBLIC_URL: 'http://localhost:8787', PQ_OWNER_EMAILS: '*' }));
  assert.deepEqual(saasFromEnv({ PQ_PUBLIC_URL: 'http://localhost:8787', PQ_OWNER_EMAILS: ' Owner@Example.com, second@example.com ' })?.ownerEmails, ['owner@example.com', 'second@example.com']);
});


test('changing the server allowlist grants and revokes Owner for an existing account', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pq-owner-'));
  const path = join(directory, 'queue.sqlite');
  let store = new Store(path);
  try {
    const session = store.accounts.consume(store.accounts.issue('existing@example.com', 'b', true), 'b');
    const account = store.accounts.session(session);
    assert.equal(store.accounts.plan(account.project_id)?.id, 'free');
    store.close(); store = new Store(path, { ownerEmails: ['existing@example.com'] });
    assert.equal(store.accounts.session(session).id, account.id);
    assert.equal(store.accounts.plan(account.project_id)?.id, 'owner');
    store.close(); store = new Store(path);
    assert.equal(store.accounts.plan(account.project_id)?.id, 'free');
    store.createDevice(account.project_id, 'first');
    assert.throws(() => store.createDevice(account.project_id, 'second'), /device_limit/);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
