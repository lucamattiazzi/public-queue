import { PublicQueue, fingerprint } from '../../../packages/sdk/src/index.js';
import type { Connection, Job } from '../../../packages/sdk/src/index.js';
import { importPublicKey } from '../../../packages/protocol/src/crypto.js';
import { terminal } from '../../../packages/protocol/src/index.js';

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id); if (!element) throw new Error(`Missing element ${id}`); return element as T;
};
const input = (id: string): HTMLInputElement => $(id);
const text = (id: string, value: string) => { $(id).textContent = value; };
const accountMode = location.pathname.startsWith('/app');
let signedIn = false;
let ownerToken = sessionStorage.getItem('pq-owner') ?? '';
if (accountMode) ownerToken = '';
let queue: PublicQueue | undefined;
let watching: AbortController | undefined;
let currentJob: string | undefined;
let project: Project | undefined;
interface Project { id: string; name: string; requireEncryption: boolean; devices: { id: string; name: string; public_key: string | null; last_seen: number | null; revoked: number; available: boolean }[]; clients: { id: string; name: string; device_id: string; revoked: number }[] }
let noticeTimer: ReturnType<typeof setTimeout>;
function notify(message: string, error = false) {
  const element = $('notice'); element.hidden = false; element.classList.toggle('error', error); element.textContent = message;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { element.hidden = true; }, error ? 12000 : 5000);
}
const explanations: Record<string, string> = {
  plan_device_limit: 'This device is paused by your current plan. Upgrade or revoke older devices.',
  plan_client_limit: 'This client is paused by your current plan. Upgrade or revoke older clients.',
  owner_does_not_need_subscription: 'Your Owner account is exempt from commercial quotas and does not need a subscription.',
  use_billing_portal: 'An existing subscription needs attention. Open Manage billing & cancellation.',
  monthly_quota_exceeded: 'Your monthly job allowance is used. Upgrade to Premium or wait until next month.',
  device_limit: 'Your plan has reached its device limit. Revoke an old device or upgrade.',
  client_limit: 'Your plan has reached its client connection limit.',
  unauthorized: 'This key is invalid or has been revoked. Check your connection.',
  storage_quota_exceeded: 'This project has reached its encrypted storage budget. Wait for pending jobs to finish or old results to expire.',
  quota_exceeded: 'This project has reached its daily or pending-job limit. Try later or contact the operator.',
  not_found: 'This job is unavailable, expired from retention, or belongs to another client.',
  attempts_exhausted: 'The device disconnected repeatedly. Check the agent before submitting a new job.',
  deadline_exceeded: 'This job expired before it could finish.',
};
function errorText(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return explanations[message] ?? message; }
async function api<T>(path: string, method = 'GET', body?: unknown, token = ownerToken): Promise<T> {
  const response = await fetch(path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'error' });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error((data as { error: string }).error); return data as T;
}
function action(id: string, run: () => Promise<void>) {
  $(id).addEventListener('click', () => { void run().catch(error => notify(errorText(error), true)); });
}
function form(id: string, run: () => Promise<void>) {
  $(id).addEventListener('submit', event => {
    event.preventDefault(); const button = $(id).querySelector<HTMLButtonElement>('button[type=submit]');
    if (button) button.disabled = true;
    void run().catch(error => notify(errorText(error), true)).finally(() => { if (button) button.disabled = false; });
  });
}
function button(label: string, run: () => Promise<void>, dangerous = false): HTMLButtonElement {
  const element = document.createElement('button'); element.type = 'button'; element.className = dangerous ? 'secondary danger' : 'secondary'; element.textContent = label;
  element.addEventListener('click', () => { element.disabled = true; void run().catch(error => notify(errorText(error), true)).finally(() => { element.disabled = false; }); }); return element;
}
async function refreshProject() {
  if (!ownerToken && !signedIn) return;
  project = await api<Project>('/v1/project');
  text('project-badge', project.name); input('pair-button').disabled = false;
  const list = $('devices'); list.replaceChildren();
  for (const device of project.devices) {
    if (device.revoked) continue;
    const row = document.createElement('div'); row.className = 'device-row';
    const info = document.createElement('div'); const name = document.createElement('strong'); name.textContent = device.name;
    const status = document.createElement('small');
    status.textContent = !device.available ? 'Paused · outside current plan limits' : !device.public_key ? 'Waiting for pairing' : Date.now() - (device.last_seen ?? 0) < 15000 ? 'Connected · ready for jobs' : 'Offline · jobs can wait';
    info.append(name, status); row.append(info, button('Revoke device', async () => {
      if (!confirm(`Revoke ${device.name}? Pending jobs will be cancelled.`)) return;
      await api(`/v1/devices/${device.id}`, 'DELETE'); await refreshProject();
    }, true)); list.append(row);
  }
  if (!list.childElementCount) list.textContent = 'No devices yet. Create a pairing code above.';
  const select = $<HTMLSelectElement>('selected-device'); const selected = select.value; select.replaceChildren();
  for (const device of project.devices.filter(device => device.public_key && !device.revoked && device.available)) {
    const option = document.createElement('option'); option.value = device.id; option.textContent = device.name; select.append(option);
  }
  if (Array.from(select.options).some(option => option.value === selected)) select.value = selected;
  $('client-form').hidden = !select.options.length;
  const clients = $('clients'); clients.replaceChildren();
  for (const client of project.clients.filter(client => !client.revoked)) {
    const row = document.createElement('div'); row.className = 'device-row';
    const label = document.createElement('span'); label.textContent = client.name;
    row.append(label, button('Revoke client', async () => { if (!confirm(`Revoke ${client.name}?`)) return; await api(`/v1/clients/${client.id}`, 'DELETE'); await refreshProject(); }, true)); clients.append(row);
  }
  $('client-management').hidden = !clients.childElementCount;
}
form('project-form', async () => {
  const created = await api<{ id: string; ownerToken: string }>('/v1/projects', 'POST', { name: input('project-name').value, requireEncryption: true }, input('admin-key').value.trim());
  input('admin-key').value = ''; ownerToken = created.ownerToken; sessionStorage.setItem('pq-owner', ownerToken);
  input('new-owner').value = ownerToken; input('owner-key').value = ownerToken; $('owner-reveal').hidden = false;
  await refreshProject(); notify('Project created. Save your owner key before closing this tab.');
});
form('login-form', async () => { ownerToken = input('owner-key').value.trim(); await refreshProject(); sessionStorage.setItem('pq-owner', ownerToken); notify('Project connected.'); });
form('device-form', async () => {
  const device = await api<{ id: string; pairingCode: string }>('/v1/devices', 'POST', { name: input('device-name').value });
  text('pair-command', `pq-agent connect --server ${location.origin} --code ${device.pairingCode} --runtime ${input('runtime').value}`);
  $('pairing').hidden = false; await refreshProject();
});
input('device-key').addEventListener('input', () => {
  const value = input('device-key').value.trim();
  void importPublicKey(value).then(() => fingerprint(value)).then(value => text('fingerprint', `Fingerprint: ${value}`)).catch(() => text('fingerprint', 'Paste the complete public key from the agent.'));
});
form('client-form', async () => {
  const deviceId = input('selected-device').value;
  const publicKey = input('device-key').value.trim(); await importPublicKey(publicKey);
  const device = project?.devices.find(device => device.id === deviceId);
  if (!device || device.public_key !== publicKey) throw new Error('This key does not match the selected device. Check the key on your computer.');
  const client = await api<{ token: string }>('/v1/clients', 'POST', { deviceId, name: input('client-name').value });
  input('new-connection').value = JSON.stringify({ server: location.origin, token: client.token, deviceId, publicKey }, null, 2);
  $('connection-reveal').hidden = false; await refreshProject(); notify('Connection created. Save it privately.');
});
function parseConnection(value: string): Connection {
  const data: unknown = JSON.parse(value);
  if (!data || typeof data !== 'object') throw new Error('Invalid connection JSON');
  const connection = data as Record<string, unknown>;
  for (const key of ['server', 'token', 'deviceId', 'publicKey']) if (typeof connection[key] !== 'string' || !connection[key]) throw new Error(`Connection is missing ${key}`);
  return { server: connection.server as string, token: connection.token as string, deviceId: connection.deviceId as string, publicKey: connection.publicKey as string };
}
async function connectBrowser(value: string) {
  const connection = parseConnection(value); await importPublicKey(connection.publicKey);
  const candidate = new PublicQueue(connection); await candidate.list();
  watching?.abort(); queue = candidate;
  sessionStorage.setItem('pq-connection', JSON.stringify(connection)); input('connection-input').value = JSON.stringify(connection, null, 2);
  $('connection-details').removeAttribute('open'); text('connection-badge', 'E2E encrypted'); input('send-button').disabled = false;
  await refreshJobs();
}
form('connection-form', async () => { await connectBrowser(input('connection-input').value); notify('Browser connected. Your local key will be saved on this browser.'); });
action('use-connection', async () => { await connectBrowser(input('new-connection').value); location.hash = 'playground'; });
function updateJob(job: Job) {
  text('job-status', job.status); text('job-id', `Job ${job.id} · attempt ${job.attempts}`);
  $('job-progress').hidden = terminal(job.status); $('cancel-job').hidden = terminal(job.status);
  text('job-message', job.status === 'queued' ? 'Saved securely. Waiting for your device — you can close this page.' : 'Your device is generating a response. You can come back later.');
}
async function watch(id: string) {
  if (!queue) return;
  watching?.abort(); const controller = new AbortController(); watching = controller; currentJob = id;
  text('output', '');
  try {
    let output = '';
    for await (const update of queue.stream(id, { signal: controller.signal, onUpdate: updateJob })) {
      if (update.type === 'reset') output = '';
      else if (update.type === 'delta') output += update.text;
      else output = update.result.text;
      if (!controller.signal.aborted) text('output', output);
    }
  }
  catch (error) { if (!controller.signal.aborted) { text('output', errorText(error)); $('job-progress').hidden = true; } }
  finally { if (!controller.signal.aborted) await refreshJobs().catch(() => {}); }
}
form('prompt-form', async () => {
  if (!queue) throw new Error('Connect your browser first');
  const job = await queue.submit({ stream: input('stream-response').checked, model: input('model').value.trim(), messages: [{ role: 'user', content: input('prompt').value }] });
  sessionStorage.setItem('pq-model', input('model').value.trim());
  notify('Job saved. It will run when your device is ready.'); updateJob(job); await refreshJobs(); void watch(job.id);
});
async function refreshJobs() {
  if (!queue) return;
  const jobs = await queue.list(); const list = $('jobs'); list.replaceChildren();
  for (const job of jobs) {
    const row = document.createElement('div'); row.className = 'job-row';
    const label = document.createElement('span'); label.textContent = `${new Date(job.createdAt).toLocaleString()} · ${job.status} · ${job.id.slice(0, 8)}`;
    row.append(label, button(terminal(job.status) ? 'Open result' : 'Follow job', async () => { void watch(job.id); })); list.append(row);
  }
  if (!jobs.length) list.textContent = 'No jobs yet. Send your first encrypted prompt above.';
}
action('cancel-job', async () => { if (queue && currentJob) { updateJob(await queue.cancel(currentJob)); await refreshJobs(); } });
action('refresh-jobs', refreshJobs); action('refresh-devices', refreshProject);
for (const [buttonId, source] of [['copy-owner', 'new-owner'], ['copy-command', 'pair-command'], ['copy-connection', 'new-connection'], ['copy-sdk', 'sdk-example']] as const) {
  action(buttonId, async () => { const node = $(source); await navigator.clipboard.writeText(node instanceof HTMLTextAreaElement ? node.value : node.textContent ?? ''); notify('Copied.'); });
}
action('sign-out', async () => { if (accountMode) await api('/v1/auth/logout', 'POST', {}); watching?.abort(); sessionStorage.clear(); location.assign(accountMode ? '/login/' : '/console/'); });
input('owner-key').value = ownerToken;
input('model').value = sessionStorage.getItem('pq-model') ?? '';
if (ownerToken) void refreshProject().catch(error => notify(errorText(error), true));
const saved = sessionStorage.getItem('pq-connection');
if (saved) void connectBrowser(saved).catch(error => notify(errorText(error), true));
setInterval(() => { if ((ownerToken || signedIn) && !document.hidden) void refreshProject().catch(() => {}); }, 5000);

interface Me { email: string; plan: { id: string; name: string; monthlyJobs: number | null; devices: number | null }; usage: { month: number; pending: number }; paidUntil: number; subscriptionStatus: string | null; cancelAtPeriodEnd: boolean; hasBilling: boolean; billingEnabled: boolean }
async function refreshAccount() {
  const me = await api<Me>('/v1/me'); signedIn = true;
  $('account-panel').hidden = false; $('owner-panel').hidden = true; $('owner-panel').parentElement?.classList.add('account-setup');
  document.querySelector<HTMLElement>('.hero')!.hidden = true;
  text('account-email', me.email);
  text('billing-status', `${me.plan.name}${me.paidUntil > Date.now() ? ` · paid through ${new Date(me.paidUntil).toLocaleDateString()}` : ''}${me.cancelAtPeriodEnd ? ' · renewal cancelled' : ''}${me.subscriptionStatus === 'past_due' ? ' · payment needs attention' : ''}`);
  text('usage-status', me.plan.id === 'owner' ? `${me.usage.month.toLocaleString()} jobs this month · ${me.usage.pending} pending · no commercial quotas · no subscription required` : `${me.usage.month.toLocaleString()} / ${me.plan.monthlyJobs?.toLocaleString()} jobs this month · ${me.usage.pending} pending · up to ${me.plan.devices} devices`);
  $('upgrade').hidden = !me.billingEnabled || me.plan.id !== 'free';
  $('billing-portal').hidden = !me.hasBilling;
  if (sessionStorage.getItem('pq-intended-plan') === 'personal' && me.plan.id === 'free') { notify('Your free account is ready. Choose Premium below to continue to secure checkout.'); sessionStorage.removeItem('pq-intended-plan'); }
  if (new URLSearchParams(location.search).get('checkout') === 'success' && me.plan.id === 'free') text('billing-status', 'Waiting for payment confirmation. Your plan updates after Stripe confirms payment.');
  await refreshProject();
}
action('upgrade', async () => {
  const result = await api<{ url: string }>('/v1/billing/checkout', 'POST', {});
  sessionStorage.removeItem('pq-intended-plan'); location.assign(result.url);
});
action('billing-portal', async () => { location.assign((await api<{ url: string }>('/v1/billing/portal', 'POST', {})).url); });
action('export-account', async () => {
  const data = await api('/v1/account/export'); const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'public-queue-account.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
action('revoke-sessions', async () => { if (!confirm('Sign out all browsers? Device and client credentials will keep working.')) return; await api('/v1/auth/revoke-sessions', 'POST', {}); sessionStorage.clear(); location.assign('/login/'); });
action('delete-account', async () => { if (prompt('Type DELETE to cancel your subscriptions and permanently delete this account and every job.') !== 'DELETE') return; await api('/v1/account', 'DELETE', { confirmation: 'DELETE' }); sessionStorage.clear(); location.assign('/'); });
for (const code of document.querySelectorAll('code')) {
  if (code.textContent?.includes('AGENT_DOWNLOAD_URL')) code.textContent = `npm install -g ${location.origin}/downloads/agent.tgz`;
  if (code.textContent?.includes('SDK_DOWNLOAD_URL')) code.textContent = `npm install ${location.origin}/downloads/sdk.tgz`;
}
if (accountMode) {
  void refreshAccount().catch(error => { if (error instanceof Error && error.message === 'unauthorized') location.replace('/login/'); else notify(errorText(error), true); });
  setInterval(() => { if (!document.hidden) void refreshAccount().catch(() => {}); }, 15000);
}
