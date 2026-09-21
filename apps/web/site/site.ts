import type { plans } from '../../../packages/protocol/src/plans.js';
interface PublicConfig { plans: typeof plans; operator: { name: string; address: string; email: string; taxId: string }; signupEnabled: boolean; billingEnabled: boolean; providerDisclosure?: string }
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
const status = (message: string, error = false) => { const el = byId('auth-status'); if (el) { el.textContent = message; el.hidden = false; el.classList.toggle('error', error); } };
const friendly: Record<string, string> = {
  email_cooldown: 'Please wait one minute before requesting another link.',
  invalid_link: 'This link expired, was already used, or belongs to another browser. Request a new link here.',
  signup_not_configured: 'Registration is not open yet. Please check back soon.',
  signup_capacity: 'This launch has reached its current account capacity. Please try again later.',
  email_capacity: 'Email sign-in is temporarily at capacity. Please try again later.',
  rate_limited: 'Too many requests. Wait a minute and try again.',
};
async function post(path: string, body: unknown) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(25000), redirect: 'error' });
  const data = await response.json() as { error?: string };
  if (!response.ok) throw new Error(friendly[data.error ?? ''] ?? 'Could not complete the request. Please try again.');
}
if (new URLSearchParams(location.search).get('plan') === 'personal') sessionStorage.setItem('pq-intended-plan', 'personal');
const rawToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (rawToken) {
  history.replaceState(null, '', location.pathname + location.search);
  byId('email-form')!.hidden = true; byId('redeem-form')!.hidden = false;
  byId('redeem-form')!.addEventListener('submit', event => {
    event.preventDefault(); const button = byId('redeem-form')!.querySelector('button')!; button.disabled = true;
    void post('/v1/auth/complete', { token: rawToken }).then(() => location.assign('/app/')).catch(error => {
      status((error as Error).message, true); byId('email-form')!.hidden = false; byId('redeem-form')!.hidden = true;
    }).finally(() => { button.disabled = false; });
  });
}
byId('email-form')?.addEventListener('submit', event => {
  event.preventDefault(); const button = byId<HTMLButtonElement>('email-button')!; button.disabled = true;
  void post('/v1/auth/request', { email: byId<HTMLInputElement>('email')!.value.trim(), acceptedTerms: byId<HTMLInputElement>('consent')!.checked })
    .then(() => status('Check your inbox. Open the sign-in link in this browser within 15 minutes. It may take a moment; check spam too.'))
    .catch(error => status((error as Error).message, true)).finally(() => { button.disabled = false; });
});
void fetch('/v1/public', { signal: AbortSignal.timeout(10000) }).then(async response => {
  if (!response.ok) return;
  const config = await response.json() as PublicConfig;
  const legal = byId('legal-operator'); if (legal) legal.textContent = [config.operator.name, config.operator.address, config.operator.taxId, config.operator.email].filter(Boolean).join(' · ') || 'Not configured — public registration is disabled.';
  const disclosure = byId('provider-disclosure'); if (disclosure && config.providerDisclosure) disclosure.textContent = config.providerDisclosure;
  const support = byId<HTMLAnchorElement>('support-link'); if (support && config.operator.email) support.href = `mailto:${config.operator.email}`;
  const operator = byId('operator-line'); if (operator && config.operator.name) operator.textContent = `${config.operator.name} · ${config.operator.taxId}`;
  if (!config.signupEnabled && byId('email-form')) { byId<HTMLButtonElement>('email-button')!.disabled = true; status('Registration is not open yet.'); }
  for (const plan of Object.values(config.plans)) {
    const list = byId(`${plan.id}-features`); if (!list) continue;
    const lines = [`${plan.devices} ${plan.devices === 1 ? 'device' : 'devices'} · ${plan.clients} client connections`, `${plan.monthlyJobs.toLocaleString('en')} jobs per calendar month`, `${plan.dailyJobs.toLocaleString('en')} jobs/day · ${plan.pendingJobs} pending jobs`, `${plan.retentionDays}-day maximum deadline and retention`, `${plan.storageBytes / 1024 / 1024} MiB payload storage budget`];
    list.replaceChildren(...lines.map(line => { const li = document.createElement('li'); li.textContent = line; return li; }));
  }
}).catch(() => { if (byId('email-form')) status('Unable to reach the service. Please try again shortly.', true); });
