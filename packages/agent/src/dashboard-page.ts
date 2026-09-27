export const dashboardHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Public Queue · Local agent</title><link rel="stylesheet" href="/dashboard.css"><script defer src="/dashboard.js"></script></head>
<body><header><span class="brand"><span class="mark" aria-hidden="true">▮▯▯</span> Public Queue</span><span>Local agent</span></header>
<main><p class="eyebrow">Your computer. Your models.</p><h1>Your device’s queue.</h1><p id="status" role="status">Connecting to the relay…</p><p id="mode" class="note"></p>
<section class="counts" aria-label="Job counts"><div><strong id="queued">—</strong><span>Waiting</span></div><div><strong id="running">—</strong><span>Running</span></div><div><strong id="succeeded">—</strong><span>Completed</span></div><div><strong id="failed">—</strong><span>Failed</span></div></section>
<section><div class="heading"><h2>Jobs</h2><button id="refresh">Refresh</button></div><p id="empty">Loading queue…</p><div id="jobs"></div><p id="updated" class="note"></p><p id="more" class="note" hidden>Showing the first 100 jobs: running first, then waiting in order, then recent history.</p><p class="note">Completed history is retained according to your relay’s retention policy. Cancelled and expired jobs appear below.</p></section>
<details><summary>Device details</summary><dl><dt>Relay</dt><dd id="relay">—</dd><dt>Device</dt><dd id="device">—</dd><dt>Configured runtime</dt><dd id="runtime">—</dd><dt>Allowed models</dt><dd id="models">—</dd></dl></details>
<p class="privacy">This dashboard shows job metadata only. Prompts, responses and credentials are not sent to this page.</p></main><footer>Available only on this computer · Updates every 3 seconds · No analytics</footer></body></html>`;

export const dashboardCss = `:root{color-scheme:light dark;--bg:#fff;--fg:#222;--muted:#595959;--line:#d4d9d8;--accent:#17665b;--tint:#f2f7f5;font:18px/1.5 Arial,sans-serif;background:var(--bg);color:var(--fg)}@media(prefers-color-scheme:dark){:root{--bg:#16181d;--fg:#ddd;--muted:#aaa;--line:#424a4a;--accent:#8ed3c0;--tint:#1c2928}}*{box-sizing:border-box}[hidden]{display:none!important}body{max-width:860px;padding:24px 20px;margin:auto}header,.heading{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}header{border-bottom:1px solid var(--line);padding-bottom:20px;font-size:14px}.brand{font-size:28px;font-weight:700;letter-spacing:-.7px}.mark{color:var(--accent);margin-right:8px}.eyebrow,.note,footer{font-size:14px;color:var(--muted)}.eyebrow{margin-top:24px}h1{font-size:36px;line-height:1.15;margin:24px 0}h2{font-size:22px}.counts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:28px 0}.counts>div{background:var(--tint);border:1px solid var(--line);padding:16px;border-radius:4px}.counts strong,.counts span{display:block}.counts strong{font-size:30px;color:var(--accent)}.counts span{font-size:14px}button{font:inherit;font-size:14px;color:var(--accent);background:var(--bg);border:1px solid var(--accent);border-radius:3px;padding:8px 14px;cursor:pointer}button:disabled{opacity:.5}button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:4px}.job{border-top:1px solid var(--line);padding:16px 0}.job-head{display:flex;gap:12px;justify-content:space-between;flex-wrap:wrap}.job code{font-size:14px;overflow-wrap:anywhere}.badge{font-size:13px;font-weight:700;color:var(--accent);padding:2px 8px;background:var(--tint);border:1px solid var(--line);border-radius:3px}.job p{margin:8px 0 0;font-size:14px;color:var(--muted)}details{border-top:1px solid var(--line);padding-top:20px;margin-top:28px}summary{cursor:pointer}dt{font-size:14px;color:var(--muted);margin-top:14px}dd{margin:0;overflow-wrap:anywhere;font-size:16px}.privacy{border-left:3px solid var(--accent);padding:12px 16px;background:var(--tint);font-size:14px;margin-top:28px}footer{border-top:1px solid var(--line);padding-top:20px;margin-top:32px}#status.error{color:var(--fg);border-left:3px solid var(--fg);padding-left:12px}@media(max-width:500px){.counts{grid-template-columns:repeat(2,1fr)}h1{font-size:30px}}`;

export const dashboardScript = `
const $ = id => document.getElementById(id);
let token = location.hash.slice(1);
try { if(token) sessionStorage.setItem('pq-dashboard', token); else token = sessionStorage.getItem('pq-dashboard') || ''; } catch {}
history.replaceState(null, '', '/');
let busy = false;
const labels = {queued:'Waiting', running:'Running', succeeded:'Completed', failed:'Failed', cancelled:'Cancelled', expired:'Expired'};
async function refresh() {
 if(busy) return;
 if(!token) { $('status').textContent='Open the dashboard using the link from pq-agent start or pq-agent gui.'; return; }
 busy=true; $('refresh').disabled=true;
 try {
  const response=await fetch('/api/status',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(12000)});
  const data=await response.json();
  if(!response.ok) throw Error(data.error === 'unauthorized' ? 'Session expired. Reopen the dashboard from the agent.' : data.error);
  $('status').className=''; $('status').textContent='Relay connected. Queue is up to date.';
  $('mode').textContent=data.consuming ? 'This agent is consuming jobs. Closing this browser tab leaves it running; stopping the terminal stops the agent.' : 'Monitor only. This window does not start inference. Keep pq-agent start or the background service running.';
  for(const key of ['queued','running','succeeded','failed']) $(key).textContent=String(data.queue.counts[key]);
  $('relay').textContent=data.server; $('device').textContent=data.deviceId; $('runtime').textContent=data.runtimeUrl; $('models').textContent=data.models.join(', ');
  const rows=data.queue.jobs.map(job=>{
   const row=document.createElement('article'); row.className='job';
   const heading=document.createElement('div'); heading.className='job-head';
   const id=document.createElement('code'); id.textContent=job.id;
   const state=document.createElement('span'); state.className='badge'; state.textContent=labels[job.status] || job.status;
   heading.append(id,state);
   const detail=document.createElement('p'); detail.textContent='Created '+new Date(job.createdAt).toLocaleString()+' · Attempts: '+job.attempts;
   row.append(heading,detail); return row;
  });
  $('jobs').replaceChildren(...rows); $('empty').hidden=rows.length>0; $('empty').textContent='No jobs for this device yet. Send a prompt from your frontend or the relay playground.';
  $('more').hidden=!data.queue.hasMore;
  $('updated').textContent='Last successful update: '+new Date(data.checkedAt).toLocaleTimeString();
 } catch(error) {
  $('status').className='error'; $('status').textContent=error instanceof Error ? error.message : 'Cannot refresh the queue.';
  if(!$('jobs').children.length) { $('empty').hidden=false; $('empty').textContent='Queue unavailable. Retrying automatically.'; }
 } finally {busy=false; $('refresh').disabled=false;}
}
$('refresh').addEventListener('click',refresh);
void refresh(); setInterval(()=>{if(!document.hidden) void refresh();},3000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden) void refresh();});
`;
