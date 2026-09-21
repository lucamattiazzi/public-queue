import { z } from 'zod';
import nodemailer from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { SaasOptions } from './saas.js';
export function saasFromEnv(env: NodeJS.ProcessEnv): SaasOptions | undefined {
  if (!env.PQ_PUBLIC_URL) return undefined;
  const operator = { name: env.PQ_OPERATOR_NAME ?? '', address: env.PQ_OPERATOR_ADDRESS ?? '', email: env.PQ_SUPPORT_EMAIL ?? '', taxId: env.PQ_OPERATOR_TAX_ID ?? '' };
  const ownerEmails = (env.PQ_OWNER_EMAILS ?? '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  z.array(z.email()).parse(ownerEmails);
  const options: SaasOptions = { ownerEmails, publicUrl: env.PQ_PUBLIC_URL, providerDisclosure: env.PQ_PROVIDER_DISCLOSURE ?? '', operator, maxAccounts: Number(env.PQ_MAX_ACCOUNTS ?? 100), maxEmailsPerDay: Number(env.PQ_MAX_EMAILS_PER_DAY ?? 500) };
  for (const n of [options.maxAccounts, options.maxEmailsPerDay]) if (!Number.isSafeInteger(n) || n! <= 0) throw new Error('Capacity limits must be positive integers');
  if (env.NODE_ENV === 'production' && (!Object.values(operator).every(Boolean) || !env.PQ_PROVIDER_DISCLOSURE)) throw new Error('Complete operator identity and provider disclosure before production launch');
  if (env.PQ_SMTP_HOST) {
    if (!env.PQ_SMTP_USER || !env.PQ_SMTP_PASSWORD || !env.PQ_EMAIL_FROM) throw new Error('SMTP requires user, password and from address');
    const port = Number(env.PQ_SMTP_PORT ?? 587);
    const mail = nodemailer.createTransport({ host: env.PQ_SMTP_HOST, port, secure: port === 465, requireTLS: true,
      auth: { user: env.PQ_SMTP_USER, pass: env.PQ_SMTP_PASSWORD }, disableFileAccess: true, disableUrlAccess: true,
      connectionTimeout: 10000, socketTimeout: 15000 });
    options.sendLogin = async (email, link) => { await mail.sendMail({ from: env.PQ_EMAIL_FROM!, to: email, subject: 'Your Public Queue sign-in link', text: `Sign in to Public Queue:\n\n${link}\n\nOpen in the same browser that requested this link, within 15 minutes. This link works once. If you did not request it, ignore this email.` }); };
  } else if (env.PQ_DEV_MAIL_DIR) {
    const url = new URL(env.PQ_PUBLIC_URL);
    if (env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('File email preview is allowed only on local development');
    const directory = resolve(env.PQ_DEV_MAIL_DIR);
    options.sendLogin = async (email, link) => { await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(resolve(directory, `${randomUUID()}.txt`), `To: ${email}\n${link}\n`, { mode: 0o600 }); };
  }
  if (env.PQ_STRIPE_SECRET_KEY || env.PQ_STRIPE_WEBHOOK_SECRET || env.PQ_STRIPE_PRICE_ID) {
    if (!env.PQ_STRIPE_SECRET_KEY || !env.PQ_STRIPE_WEBHOOK_SECRET || !env.PQ_STRIPE_PRICE_ID) throw new Error('Configure all three Stripe variables together');
    options.billing = { secretKey: env.PQ_STRIPE_SECRET_KEY, webhookSecret: env.PQ_STRIPE_WEBHOOK_SECRET, priceId: env.PQ_STRIPE_PRICE_ID, automaticTax: env.PQ_STRIPE_AUTOMATIC_TAX === 'true' };
  }
  return options;
}
