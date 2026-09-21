import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../packages/server/src/store.js';

test('verified login is browser bound, single use, and reuses the account', () => {
  let now = 1_800_000_000_000;
  const store = new Store(':memory:', { clock: () => now });
  try {
    const link = store.accounts.issue('person@example.com', 'browser', true);
    assert.throws(() => store.accounts.consume(link, 'wrong'), /invalid_link/);
    const session = store.accounts.consume(link, 'browser');
    const account = store.accounts.session(session);
    assert.equal(account.email, 'person@example.com');
    assert.throws(() => store.accounts.consume(link, 'browser'), /invalid_link/);
    assert.throws(() => store.accounts.issue('person@example.com', 'browser', true), /email_cooldown/);
    now += 61_000;
    const again = store.accounts.consume(store.accounts.issue(account.email, 'browser', false), 'browser');
    assert.equal(store.accounts.session(again).id, account.id);
    store.accounts.logout(session);
    assert.throws(() => store.accounts.session(session), /unauthorized/);
    now += 31 * 86400_000;
    assert.throws(() => store.accounts.session(again), /unauthorized/);
  } finally { store.close(); }
});

test('free device limits and paid expiry apply on the server', () => {
  let now = 1_800_000_000_000;
  const store = new Store(':memory:', { clock: () => now });
  try {
    const session = store.accounts.consume(store.accounts.issue('paid@example.com', 'b', true), 'b');
    const account = store.accounts.session(session);
    store.createDevice(account.project_id, 'first');
    assert.throws(() => store.createDevice(account.project_id, 'second'), /device_limit/);
    store.accounts.setCustomer(account.id, 'cus_1');
    store.accounts.applyBilling('evt_1', 'cus_1', { id: 'sub_1', status: 'active', paidUntil: now + 1000, cancelAtPeriodEnd: false });
    store.createDevice(account.project_id, 'second');
    assert.equal(store.accounts.plan(account.project_id)?.id, 'personal');
    assert.equal(store.accounts.applyBilling('evt_1', 'cus_1', { id: 'sub_1', status: 'canceled', paidUntil: 0, cancelAtPeriodEnd: false }), false);
    now += 1001;
    assert.equal(store.accounts.plan(account.project_id)?.id, 'free');
    assert.throws(() => store.createDevice(account.project_id, 'third'), /device_limit/);
  } finally { store.close(); }
});

test('expired links never create accounts and signup needs terms consent', () => {
  let now = 1_800_000_000_000;
  const store = new Store(':memory:', { clock: () => now });
  try {
    assert.throws(() => store.accounts.issue('new@example.com', 'b', false), /terms_required/);
    const token = store.accounts.issue('new@example.com', 'b', true);
    now += 16 * 60_000;
    assert.throws(() => store.accounts.consume(token, 'b'), /invalid_link/);
  } finally { store.close(); }
});

test('monthly allowance survives job expiry and crosses daily boundaries', () => {
  let now = Date.UTC(2026, 8, 1);
  const store = new Store(':memory:', { clock: () => now });
  try {
    const account = store.accounts.session(store.accounts.consume(store.accounts.issue('quota@example.com', 'b', true), 'b'));
    const device = store.createDevice(account.project_id, 'home');
    store.pair(device.pairingCode, 'public-key');
    const client = store.createClient(account.project_id, device.id, 'browser');
    for (let i = 0; i < 500; i++) {
      if (i && i % 50 === 0) now = Date.UTC(2026, 8, 1 + i / 50);
      store.submit(client.id, { id: crypto.randomUUID(), ttlSeconds: 60, payload: { mode: 'encrypted', data: { version: 1, publicKey: 'p', iv: 'i', ciphertext: 'c' } } });
      now += 61_000;
    }
    now = Date.UTC(2026, 8, 12);
    assert.throws(() => store.submit(client.id, { id: crypto.randomUUID(), ttlSeconds: 60, payload: { mode: 'encrypted', data: { version: 1, publicKey: 'p', iv: 'i', ciphertext: 'c' } } }), /monthly_quota_exceeded/);
    assert.equal(store.accounts.usage(account.project_id).month, 500);
    now = Date.UTC(2026, 9, 1);
    assert.equal(store.accounts.usage(account.project_id).month, 0);
  } finally { store.close(); }
});

test('downgrade pauses additional devices without deleting keys and upgrade restores them', () => {
  let now = Date.UTC(2026, 8, 1);
  const store = new Store(':memory:', { clock: () => now });
  try {
    const account = store.accounts.session(store.accounts.consume(store.accounts.issue('devices@example.com', 'b', true), 'b'));
    store.accounts.setCustomer(account.id, 'cus_devices');
    store.accounts.applyBilling('evt_a', 'cus_devices', { id: 'sub_a', status: 'active', paidUntil: now + 1000, cancelAtPeriodEnd: false });
    store.createDevice(account.project_id, 'first');
    const second = store.createDevice(account.project_id, 'second');
    store.pair(second.pairingCode, 'public-key');
    const client = store.createClient(account.project_id, second.id, 'browser');
    now += 1001;
    assert.throws(() => store.claim(second.id), /plan_device_limit/);
    assert.throws(() => store.submit(client.id, { id: crypto.randomUUID(), ttlSeconds: 60, payload: { mode: 'encrypted', data: { version: 1, publicKey: 'p', iv: 'i', ciphertext: 'c' } } }), /plan_device_limit/);
    store.accounts.applyBilling('evt_b', 'cus_devices', { id: 'sub_a', status: 'active', paidUntil: now + 1000, cancelAtPeriodEnd: false });
    assert.equal(store.claim(second.id), null);
  } finally { store.close(); }
});

test('deleting an account revokes sessions and removes its device and client access', () => {
  const store = new Store(':memory:');
  try {
    const session = store.accounts.consume(store.accounts.issue('delete@example.com', 'b', true), 'b');
    const account = store.accounts.session(session);
    const device = store.createDevice(account.project_id, 'home');
    const agent = store.pair(device.pairingCode, 'public-key');
    const client = store.createClient(account.project_id, device.id, 'client');
    store.accounts.delete(account.id);
    assert.throws(() => store.accounts.session(session), /unauthorized/);
    assert.throws(() => store.client(client.token), /unauthorized/);
    assert.throws(() => store.agent(agent.token), /unauthorized/);
    assert.throws(() => store.project(account.project_id), /not_found/);
  } finally { store.close(); }
});
