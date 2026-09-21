import Stripe from 'stripe';
import type { Accounts, Account, BillingState } from './accounts.js';
import { Fault } from './errors.js';
export interface BillingOptions { secretKey: string; webhookSecret: string; priceId: string; automaticTax?: boolean }
export function subscriptionState(subscription: Stripe.Subscription, previous: Account, priceId: string): BillingState {
  const item = subscription.items.data[0];
  const invoice = subscription.latest_invoice;
  const valid = subscription.items.data.length === 1 && item?.price.id === priceId;
  const paid = invoice && typeof invoice !== 'string' && invoice.status === 'paid';
  const terminated = ['canceled', 'unpaid', 'incomplete_expired', 'paused'].includes(subscription.status);
  const paidUntil = !valid || terminated ? 0 : paid && subscription.status === 'active'
    ? (item?.current_period_end ?? 0) * 1000 : previous.subscription === subscription.id ? previous.paid_until : 0;
  return { id: subscription.id, status: subscription.status, paidUntil, cancelAtPeriodEnd: subscription.cancel_at_period_end };
}
export class Billing {
  readonly stripe: Stripe;
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly accounts: Accounts, private readonly options: BillingOptions, private readonly origin: string) {
    this.stripe = new Stripe(options.secretKey, { maxNetworkRetries: 2, timeout: 15000 });
  }
  async exclusive<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run); this.locks.set(key, next);
    try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  async checkout(id: string): Promise<string> {
    return this.exclusive(id, async () => {
      let account = this.accounts.get(id);
      if (this.accounts.plan(account.project_id)?.id === 'owner') throw new Fault('owner_does_not_need_subscription', 409);
      if (account.subscription && !['canceled', 'incomplete_expired'].includes(account.subscription_status ?? '')) throw new Fault('use_billing_portal', 409);
      if (account.stripe_customer) {
        const current = await this.stripe.subscriptions.list({ customer: account.stripe_customer, status: 'all', limit: 100 });
        if (current.has_more) throw new Fault('billing_review_required', 503);
        if (current.data.some(s => !['canceled', 'incomplete_expired'].includes(s.status))) throw new Fault('use_billing_portal', 409);
      }
      if (account.checkout_url && account.checkout_until > Date.now()) return account.checkout_url;
      if (account.stripe_customer) {
        const sessions = await this.stripe.checkout.sessions.list({ customer: account.stripe_customer, status: 'open', limit: 100 });
        if (sessions.has_more) throw new Fault('billing_review_required', 503);
        const pending = sessions.data.find(session => session.metadata?.accountId === id && session.url);
        if (pending?.url) {
          this.accounts.setCheckout(id, { id: pending.id, url: pending.url, expires: pending.expires_at * 1000 });
          return pending.url;
        }
      }
      const price = await this.stripe.prices.retrieve(this.options.priceId);
      if (!price.active || price.currency !== 'eur' || price.unit_amount !== 2900 || price.recurring?.interval !== 'year' || price.recurring.interval_count !== 1 || price.tax_behavior !== 'inclusive') throw new Fault('billing_price_misconfigured', 503);
      if (!account.stripe_customer) {
        const customer = await this.stripe.customers.create({ email: account.email, metadata: { accountId: id } }, { idempotencyKey: `customer:${id}` });
        this.accounts.setCustomer(id, customer.id); account = this.accounts.get(id);
      }
      const generation = this.accounts.checkoutGeneration(id);
      account = this.accounts.get(id);
      const checkout = await this.stripe.checkout.sessions.create({
        mode: 'subscription', customer: account.stripe_customer!, line_items: [{ price: price.id, quantity: 1 }],
        success_url: `${this.origin}/app/?checkout=success`, cancel_url: `${this.origin}/app/?checkout=cancelled`,
        expires_at: Math.floor(account.checkout_until / 1000), billing_address_collection: 'required',
        customer_update: { address: 'auto', name: 'auto' }, automatic_tax: { enabled: this.options.automaticTax ?? false },
        metadata: { accountId: id }, subscription_data: { metadata: { accountId: id } },
      }, { idempotencyKey: `checkout:${id}:${generation}` });
      if (!checkout.url) throw new Fault('checkout_unavailable', 503);
      this.accounts.setCheckout(id, { id: checkout.id, url: checkout.url, expires: checkout.expires_at * 1000 });
      return checkout.url;
    });
  }
  async portal(account: Account): Promise<string> {
    if (!account.stripe_customer) throw new Fault('no_billing_account', 409);
    return (await this.stripe.billingPortal.sessions.create({ customer: account.stripe_customer, return_url: `${this.origin}/app/` })).url;
  }
  async webhook(raw: Buffer, signature: string): Promise<void> {
    let event: Stripe.Event;
    try { event = this.stripe.webhooks.constructEvent(raw, signature, this.options.webhookSecret); } catch { throw new Fault('invalid_signature', 400); }
    if (event.livemode !== this.options.secretKey.startsWith('sk_live_')) throw new Fault('billing_mode_mismatch');
    if (!['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed', 'checkout.session.completed'].includes(event.type)) return;
    const object = event.data.object as { customer?: string | { id: string } | null };
    const customer = typeof object.customer === 'string' ? object.customer : object.customer?.id;
    if (!customer) return;
    const account = this.accounts.byCustomer(customer);
    if (!account) return; // Unrelated Stripe products/customers are outside this service.
    await this.exclusive(account.id, async () => {
      if (this.accounts.hasEvent(event.id)) return;
      // Fetch present state instead of trusting the arrival order of webhook snapshots.
      const subscriptions = await this.stripe.subscriptions.list({ customer, status: 'all', limit: 100, expand: ['data.latest_invoice'] });
      if (subscriptions.has_more) throw new Fault('billing_review_required', 503);
      const candidates = subscriptions.data.filter(s => s.items.data.some(i => i.price.id === this.options.priceId));
      const active = candidates.filter(s => !['canceled', 'incomplete_expired'].includes(s.status));
      if (active.length > 1) throw new Fault('duplicate_subscription', 503);
      const current = active[0] ?? candidates.sort((a, b) => b.created - a.created)[0];
      if (!current) return;
      this.accounts.applyBilling(event.id, customer, subscriptionState(current, this.accounts.get(account.id), this.options.priceId));
    });
  }
  async deleteAccount(id: string): Promise<void> {
    await this.exclusive(id, async () => {
      const account = this.accounts.get(id);
      if (account.stripe_customer) {
        // Also closes the race with a completed checkout whose webhook has not arrived.
        const pending = await this.stripe.checkout.sessions.list({ customer: account.stripe_customer, status: 'open', limit: 100 });
        if (pending.has_more) throw new Fault('billing_review_required', 503);
        for (const session of pending.data) await this.stripe.checkout.sessions.expire(session.id);
        const subscriptions = await this.stripe.subscriptions.list({ customer: account.stripe_customer, status: 'all', limit: 100 });
        if (subscriptions.has_more) throw new Fault('billing_review_required', 503);
        for (const subscription of subscriptions.data) if (!['canceled', 'incomplete_expired'].includes(subscription.status)) await this.stripe.subscriptions.cancel(subscription.id);
      }
      this.accounts.delete(id);
    });
  }
}
