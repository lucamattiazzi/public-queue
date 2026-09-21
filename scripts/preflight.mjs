import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
const env = { ...parseEnv(readFileSync('.env', 'utf8')), ...process.env };
const errors = [];
for (const key of ['PQ_DOMAIN', 'PQ_PUBLIC_URL', 'PQ_ADMIN_TOKEN', 'PQ_OPERATOR_NAME', 'PQ_OPERATOR_ADDRESS', 'PQ_OPERATOR_TAX_ID', 'PQ_SUPPORT_EMAIL', 'PQ_PROVIDER_DISCLOSURE', 'PQ_SMTP_HOST', 'PQ_SMTP_USER', 'PQ_SMTP_PASSWORD', 'PQ_EMAIL_FROM']) if (!env[key]?.trim()) errors.push(`${key} is required`);
if ((env.PQ_ADMIN_TOKEN?.length ?? 0) < 32) errors.push('Administrator secret must contain 32+ characters');
if (env.PQ_DOMAIN?.endsWith('.example.com') || env.PQ_DOMAIN === 'queue.example.com') errors.push('Replace the example domain');
if (env.PQ_PUBLIC_URL !== `https://${env.PQ_DOMAIN}`) errors.push('PQ_PUBLIC_URL must be https:// followed by PQ_DOMAIN, without trailing slash');
for (const key of ['PQ_MAX_ACCOUNTS', 'PQ_MAX_EMAILS_PER_DAY']) if (!Number.isSafeInteger(Number(env[key])) || Number(env[key]) < 1) errors.push(`${key} must be positive`);
const keys = ['PQ_STRIPE_SECRET_KEY', 'PQ_STRIPE_WEBHOOK_SECRET', 'PQ_STRIPE_PRICE_ID'];
if (keys.some(k => env[k]) && keys.some(k => !env[k])) errors.push('Configure all Stripe keys together');
if (errors.length) { console.error(errors.map(e => `- ${e}`).join('\n')); process.exitCode = 1; }
else console.log(`Configuration fields valid. Billing: ${env.PQ_STRIPE_SECRET_KEY?.startsWith('sk_live_') ? 'LIVE' : env.PQ_STRIPE_SECRET_KEY ? 'TEST' : 'disabled'}. This does not verify DNS, SMTP, Stripe connectivity or legal compliance.`);
