import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { plans, ownerPlan, type Plan } from '../../protocol/src/plans.js';
import { Fault } from './errors.js';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
export const termsVersion = '2026-09-20';
export interface Account {
  id: string; email: string; project_id: string; created_at: number; terms_version: string;
  stripe_customer: string | null; subscription: string | null; subscription_status: string | null;
  paid_until: number; cancel_at_period_end: number;
  checkout_id: string | null; checkout_url: string | null; checkout_until: number; checkout_generation: number;
}
export interface BillingState { id: string; status: string; paidUntil: number; cancelAtPeriodEnd: boolean }
export class Accounts {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number, private readonly createProject: () => string, private readonly ownerEmails: readonly string[] = []) {
    db.exec(`CREATE TABLE IF NOT EXISTS accounts(
      id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),created_at INTEGER NOT NULL,terms_version TEXT NOT NULL,
      stripe_customer TEXT UNIQUE,subscription TEXT,subscription_status TEXT,paid_until INTEGER NOT NULL DEFAULT 0,cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      checkout_id TEXT,checkout_url TEXT,checkout_until INTEGER NOT NULL DEFAULT 0,checkout_generation INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_links(email TEXT PRIMARY KEY,hash TEXT NOT NULL UNIQUE,challenge TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,consent INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_events(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mail_usage(day INTEGER PRIMARY KEY,count INTEGER NOT NULL);`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  issue(email: string, challenge: string, consent: boolean, maxAccounts = 100, maxEmailsPerDay = 500): string {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT id FROM accounts WHERE email=?').get(email);
      if (!existing && !consent) throw new Fault('terms_required');
      if (!existing && (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n >= maxAccounts) throw new Fault('signup_capacity', 503);
      const previous = this.db.prepare('SELECT created_at FROM login_links WHERE email=?').get(email) as { created_at: number } | undefined;
      if (previous && previous.created_at > this.now() - 60_000) throw new Fault('email_cooldown', 429);
      const day = Math.floor(this.now() / 86400_000);
      const usage = this.db.prepare('SELECT count FROM mail_usage WHERE day=?').get(day) as { count: number } | undefined;
      if ((usage?.count ?? 0) >= maxEmailsPerDay) throw new Fault('email_capacity', 503);
      this.db.prepare('INSERT INTO mail_usage VALUES(?,1) ON CONFLICT(day) DO UPDATE SET count=count+1').run(day);
      const token = secret();
      this.db.prepare('INSERT INTO login_links VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET hash=excluded.hash,challenge=excluded.challenge,created_at=excluded.created_at,expires_at=excluded.expires_at,consent=excluded.consent').run(email, hash(token), hash(challenge), this.now(), this.now() + 900_000, Number(consent));
      return token;
    });
  }
  consume(token: string, challenge: string, maxAccounts = 100): string {
    return this.transaction(() => {
      const link = this.db.prepare('SELECT email,consent FROM login_links WHERE hash=? AND challenge=? AND expires_at>?').get(hash(token), hash(challenge), this.now()) as { email: string; consent: number } | undefined;
      if (!link) throw new Fault('invalid_link', 401);
      let account = this.db.prepare('SELECT id FROM accounts WHERE email=?').get(link.email) as { id: string } | undefined;
      if (!account) {
        if (!link.consent) throw new Fault('terms_required');
        if ((this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n >= maxAccounts) throw new Fault('signup_capacity', 503);
        account = { id: randomUUID() };
        this.db.prepare('INSERT INTO accounts(id,email,project_id,created_at,terms_version) VALUES(?,?,?,?,?)').run(account.id, link.email, this.createProject(), this.now(), termsVersion);
      }
      // Keep the timestamp for throttling; erase the redeemable secret.
      this.db.prepare('UPDATE login_links SET hash=?,expires_at=0 WHERE email=?').run(hash(secret()), link.email);
      const session = secret();
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(session), account.id, this.now() + 30 * 86400_000);
      return session;
    });
  }
  session(token: string): Account {
    const account = this.db.prepare('SELECT a.* FROM accounts a JOIN sessions s ON a.id=s.account_id WHERE s.hash=? AND s.expires_at>?').get(hash(token), this.now()) as unknown as Account | undefined;
    if (!account) throw new Fault('unauthorized', 401); return account;
  }
  get(id: string): Account {
    const account = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) as unknown as Account | undefined;
    if (!account) throw new Fault('not_found', 404); return account;
  }
  byCustomer(customer: string): Account | undefined { return this.db.prepare('SELECT * FROM accounts WHERE stripe_customer=?').get(customer) as unknown as Account | undefined; }
  logout(token: string): void { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token)); }
  revokeSessions(id: string): void { this.db.prepare('DELETE FROM sessions WHERE account_id=?').run(id); }
  plan(project: string): Plan | undefined {
    const account = this.db.prepare('SELECT paid_until,email FROM accounts WHERE project_id=?').get(project) as { paid_until: number; email: string } | undefined;
    if (account && this.ownerEmails.includes(account.email.toLowerCase())) return ownerPlan;
    return account ? account.paid_until > this.now() ? plans.personal : plans.free : undefined;
  }
  setCustomer(id: string, customer: string): void { this.db.prepare('UPDATE accounts SET stripe_customer=? WHERE id=? AND stripe_customer IS NULL').run(customer, id); }
  checkoutGeneration(id: string): number {
    this.db.prepare('UPDATE accounts SET checkout_generation=checkout_generation+1,checkout_until=?,checkout_id=NULL,checkout_url=NULL WHERE id=? AND checkout_until<=?').run(this.now() + 1860_000, id, this.now());
    return this.get(id).checkout_generation;
  }
  setCheckout(id: string, checkout: { id: string; url: string; expires: number }): void {
    this.db.prepare('UPDATE accounts SET checkout_id=?,checkout_url=?,checkout_until=? WHERE id=?').run(checkout.id, checkout.url, checkout.expires, id);
  }
  hasEvent(id: string): boolean { return Boolean(this.db.prepare('SELECT id FROM billing_events WHERE id=?').get(id)); }
  applyBilling(event: string, customer: string, state: BillingState): boolean {
    return this.transaction(() => {
      if (this.hasEvent(event)) return false;
      const account = this.byCustomer(customer);
      if (!account) throw new Fault('unknown_customer', 503);
      this.db.prepare('UPDATE accounts SET subscription=?,subscription_status=?,paid_until=?,cancel_at_period_end=? WHERE id=?').run(state.id, state.status, state.paidUntil, Number(state.cancelAtPeriodEnd), account.id);
      this.db.prepare('INSERT INTO billing_events VALUES(?,?)').run(event, this.now());
      return true;
    });
  }
  usage(project: string): { month: number; pending: number } {
    const date = new Date(this.now());
    const monthStart = Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 86400_000);
    return {
      month: (this.db.prepare('SELECT COALESCE(SUM(count),0) AS n FROM usage WHERE project_id=? AND day>=?').get(project, monthStart) as { n: number }).n,
      pending: (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id=? AND status IN ('queued','running')").get(project) as { n: number }).n,
    };
  }
  delete(id: string): void {
    this.transaction(() => {
      const account = this.get(id);
      this.db.prepare('DELETE FROM accounts WHERE id=?').run(id);
      this.db.prepare('DELETE FROM login_links WHERE email=?').run(account.email);
      for (const table of ['jobs', 'clients', 'devices', 'usage']) this.db.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(account.project_id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(account.project_id);
    });
  }
  sweep(): void {
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(this.now());
    this.db.prepare('DELETE FROM login_links WHERE created_at<?').run(this.now() - 86400_000);
    this.db.prepare('DELETE FROM mail_usage WHERE day<?').run(Math.floor(this.now() / 86400_000) - 2);
  }
}
