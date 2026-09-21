import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { Store } from '../packages/server/src/store.js';
import { Billing, subscriptionState } from '../packages/server/src/billing.js';
function fixture() {
  const store = new Store(':memory:');
  const account = store.accounts.session(store.accounts.consume(store.accounts.issue('billing@example.com', 'b', true), 'b'));
  store.accounts.setCustomer(account.id, 'cus_test');
  const billing = new Billing(store.accounts, { secretKey: 'sk_test_fixture', webhookSecret: 'whsec_fixture', priceId: 'price_personal' }, 'https://queue.example.com');
  return { store, account: store.accounts.get(account.id), billing };
}
const subscription = (status = 'active', invoiceStatus = 'paid') => ({ id: 'sub_test', customer: 'cus_test', created: 100, status, cancel_at_period_end: false, items: { data: [{ current_period_end: 2_000_000_000, price: { id: 'price_personal' } }] }, latest_invoice: { status: invoiceStatus } }) as unknown as Stripe.Subscription;
test('billing grants only paid matching subscriptions; past due never extends entitlement', () => {
  const { store, account } = fixture();
  try {
    assert.equal(subscriptionState(subscription(), account, 'price_personal').paidUntil, 2_000_000_000_000);
    assert.equal(subscriptionState(subscription(), account, 'price_wrong').paidUntil, 0);
    assert.equal(subscriptionState(subscription('active', 'open'), account, 'price_personal').paidUntil, 0);
    const paid = { ...account, subscription: 'sub_test', paid_until: 1_900_000_000_000 };
    assert.equal(subscriptionState(subscription('past_due', 'open'), paid, 'price_personal').paidUntil, paid.paid_until);
    assert.equal(subscriptionState(subscription('canceled'), paid, 'price_personal').paidUntil, 0);
  } finally { store.close(); }
});
test('real Stripe signature verification, duplicate delivery and stale event use current state', async () => {
  const { store, account, billing } = fixture();
  let calls = 0;
  billing.stripe.subscriptions.list = (async () => { calls++; return { data: [subscription()], has_more: false }; }) as unknown as typeof billing.stripe.subscriptions.list;
  const raw = Buffer.from(JSON.stringify({ id: 'evt_test', type: 'customer.subscription.deleted', livemode: false, data: { object: { customer: 'cus_test', status: 'canceled' } } }));
  const signature = billing.stripe.webhooks.generateTestHeaderString({ payload: raw.toString(), secret: 'whsec_fixture' });
  try {
    await assert.rejects(billing.webhook(raw, 'bad'), /invalid_signature/);
    await Promise.all([billing.webhook(raw, signature), billing.webhook(raw, signature)]);
    assert.equal(calls, 1); assert.equal(store.accounts.plan(account.project_id)?.id, 'personal');
    const tampered = Buffer.from(raw.toString().replace('evt_test', 'evt_changed'));
    await assert.rejects(billing.webhook(tampered, signature), /invalid_signature/);
  } finally { store.close(); }
});
test('checkout blocks an existing Stripe subscription even before its webhook arrives', async () => {
  const { store, account, billing } = fixture();
  billing.stripe.subscriptions.list = (async () => ({ data: [subscription()], has_more: false })) as unknown as typeof billing.stripe.subscriptions.list;
  try { await assert.rejects(billing.checkout(account.id), /use_billing_portal/); } finally { store.close(); }
});
test('concurrent checkout creates one session and reuses its durable URL', async () => {
  const { store, account, billing } = fixture();
  let created = 0;
  billing.stripe.checkout.sessions.list = (async () => ({ data: [], has_more: false })) as unknown as typeof billing.stripe.checkout.sessions.list;
  billing.stripe.subscriptions.list = (async () => ({ data: [], has_more: false })) as unknown as typeof billing.stripe.subscriptions.list;
  billing.stripe.prices.retrieve = (async () => ({ id: 'price_personal', active: true, currency: 'eur', unit_amount: 2900, recurring: { interval: 'year', interval_count: 1 }, tax_behavior: 'inclusive' })) as unknown as typeof billing.stripe.prices.retrieve;
  billing.stripe.checkout.sessions.create = (async (params: Stripe.Checkout.SessionCreateParams) => {
    created++; assert.equal(params.line_items?.[0]?.quantity, 1); assert.ok(params.expires_at! * 1000 > Date.now() + 1800_000);
    return { id: 'cs_test', url: 'https://checkout.stripe.com/test', expires_at: params.expires_at };
  }) as unknown as typeof billing.stripe.checkout.sessions.create;
  try {
    const urls = await Promise.all([billing.checkout(account.id), billing.checkout(account.id)]);
    assert.deepEqual(urls, ['https://checkout.stripe.com/test', 'https://checkout.stripe.com/test']); assert.equal(created, 1);
  } finally { store.close(); }
});
test('checkout recovers a remote open session after a lost create response', async () => {
  const { store, account, billing } = fixture();
  billing.stripe.subscriptions.list = (async () => ({ data: [], has_more: false })) as unknown as typeof billing.stripe.subscriptions.list;
  billing.stripe.checkout.sessions.list = (async () => ({ data: [{ id: 'cs_recover', url: 'https://checkout.stripe.com/recovered', expires_at: Math.floor(Date.now() / 1000) + 1800, metadata: { accountId: account.id } }], has_more: false })) as unknown as typeof billing.stripe.checkout.sessions.list;
  billing.stripe.prices.retrieve = (async () => { throw new Error('Unexpected price request'); }) as unknown as typeof billing.stripe.prices.retrieve;
  try { assert.equal(await billing.checkout(account.id), 'https://checkout.stripe.com/recovered'); } finally { store.close(); }
});

test('Premium follows paid renewal, scheduled cancellation, payment failure and local expiry', async () => {
  let now = Date.UTC(2026, 8, 20);
  const store = new Store(':memory:', { clock: () => now });
  const account = store.accounts.session(store.accounts.consume(store.accounts.issue('lifecycle@example.com', 'b', true), 'b'));
  store.accounts.setCustomer(account.id, 'cus_test');
  const billing = new Billing(store.accounts, { secretKey: 'sk_test_fixture', webhookSecret: 'whsec_fixture', priceId: 'price_personal' }, 'https://queue.example.com');
  let current = subscription();
  current.items.data[0]!.current_period_end = Math.floor(now / 1000) + 100;
  billing.stripe.subscriptions.list = (async () => ({ data: [current], has_more: false })) as unknown as typeof billing.stripe.subscriptions.list;
  async function deliver(id: string, type: string) {
    const raw = Buffer.from(JSON.stringify({ id, type, livemode: false, data: { object: { customer: 'cus_test' } } }));
    await billing.webhook(raw, billing.stripe.webhooks.generateTestHeaderString({ payload: raw.toString(), secret: 'whsec_fixture' }));
  }
  try {
    assert.equal(store.accounts.plan(account.project_id)?.id, 'free');
    await deliver('evt_paid_first', 'invoice.paid');
    assert.equal(store.accounts.plan(account.project_id)?.id, 'personal');
    const firstEnd = store.accounts.get(account.id).paid_until;
    current.cancel_at_period_end = true;
    await deliver('evt_cancel_scheduled', 'customer.subscription.updated');
    assert.equal(store.accounts.plan(account.project_id)?.id, 'personal');
    assert.equal(store.accounts.get(account.id).paid_until, firstEnd);
    current.cancel_at_period_end = false;
    current.items.data[0]!.current_period_end += 100;
    await deliver('evt_renewed', 'invoice.paid');
    const renewedEnd = store.accounts.get(account.id).paid_until;
    assert.equal(renewedEnd, firstEnd + 100_000);
    current.status = 'past_due';
    current.latest_invoice = { status: 'open' } as Stripe.Invoice;
    current.items.data[0]!.current_period_end += 100;
    await deliver('evt_failed_renewal', 'invoice.payment_failed');
    assert.equal(store.accounts.get(account.id).paid_until, renewedEnd);
    now = renewedEnd + 1;
    assert.equal(store.accounts.plan(account.project_id)?.id, 'free');
  } finally { store.close(); }
});
