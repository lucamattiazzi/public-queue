#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { fingerprint, generateIdentity, restoreIdentity } from '../../protocol/src/crypto.js';
import { requireSecureUrl } from '../../protocol/src/index.js';
import { agentRequest, discoverModels, runWorker, runtimeBase } from './worker.js';
import { startDashboard } from './dashboard.js';
import { startMenuBar } from './menubar.js';
import type { AgentQueue } from '../../protocol/src/index.js';

const presets: Record<string, string> = { ollama: 'http://127.0.0.1:11434/v1', lmstudio: 'http://127.0.0.1:1234/v1', 'llama.cpp': 'http://127.0.0.1:8080/v1', omlx: 'http://127.0.0.1:8000/v1', vllm: 'http://127.0.0.1:8000/v1' };
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  server: { type: 'string' }, code: { type: 'string' }, runtime: { type: 'string' },
  'runtime-url': { type: 'string' }, models: { type: 'string' }, config: { type: 'string' },
  'allow-plaintext': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  headless: { type: 'boolean' },
  'no-open': { type: 'boolean' },
} });
const configPath = resolve(values.config ?? join(homedir(), '.config/public-queue/agent.json'));
const configSchema = z.object({
  server: z.string(), token: z.string(), deviceId: z.uuid(), publicKey: z.string(),
  privateKey: z.record(z.string(), z.unknown()), runtimeUrl: z.string(), models: z.array(z.string()).min(1),
  runtimeKey: z.string().optional(), allowPlaintext: z.boolean().default(false),
});
const readConfig = async () => configSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
async function saveConfig(value: unknown): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600); await rename(temporary, configPath);
}
async function ask(question: string, fallback?: string): Promise<string> {
  if (!process.stdin.isTTY) { if (fallback) return fallback; throw new Error(`Missing ${question}; provide its CLI option`); }
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await input.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback || ''; }
  finally { input.close(); }
}
async function connect(): Promise<void> {
  try { await readFile(configPath); throw new Error(`An agent already exists at ${configPath}. Use another --config path to pair a new device.`); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const server = requireSecureUrl(values.server ?? await ask('Server URL'));
  const code = values.code ?? await ask('Pairing code');
  const runtime = values.runtime ?? await ask('Runtime: ollama, lmstudio, llama.cpp, omlx, vllm, custom', 'ollama');
  if (!presets[runtime] && runtime !== 'custom') throw new Error('Unknown runtime. Use --runtime custom --runtime-url URL for another compatible server.');
  const runtimeUrl = runtimeBase(values['runtime-url'] ?? presets[runtime] ?? await ask('Runtime URL including /v1'));
  const runtimeKey = process.env.PQ_RUNTIME_KEY;
  console.log(`Checking ${runtimeUrl}…`);
  const available = await discoverModels(runtimeUrl, runtimeKey);
  if (!available.length) throw new Error('No models available. Load/download a model in your runtime and retry.');
  console.log(`Available models:\n${available.map(model => `  ${model}`).join('\n')}`);
  const selected = values.models ?? await ask('Allowed models, separated by commas', available[0]);
  const models = selected.split(',').map(model => model.trim()).filter(Boolean);
  if (!models.length || models.some(model => !available.includes(model))) throw new Error('Select models from the discovered list');
  const identity = await generateIdentity(true);
  const paired = await agentRequest<{ token: string; deviceId: string }>(server, '', '/v1/pair', { code, publicKey: identity.publicKey });
  await saveConfig({ server, ...paired, publicKey: identity.publicKey, privateKey: await crypto.subtle.exportKey('jwk', identity.privateKey), runtimeUrl, models, ...(runtimeKey ? { runtimeKey } : {}), allowPlaintext: values['allow-plaintext'] ?? false });
  console.log(`\nConnected. Credentials saved privately at ${configPath}\n\nDevice public key (copy into the dashboard):\n${identity.publicKey}\n\nFingerprint: ${await fingerprint(identity.publicKey)}\n\nRun: pq-agent start\nKeep running after login: pq-agent service install`);
}
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unitQuote = (value: string) => `"${value.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
async function service(action: string): Promise<void> {
  if (!['install', 'uninstall'].includes(action)) throw new Error('Use pq-agent service install|uninstall');
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`${command} failed. See docs/DEPLOYMENT.md for manual service setup.`);
  };
  if (process.platform === 'darwin') {
    const target = join(homedir(), 'Library/LaunchAgents/dev.public-queue.agent.plist');
    const domain = `gui/${process.getuid!()}`;
    if (action === 'uninstall') { run('launchctl', ['bootout', `${domain}/dev.public-queue.agent`]); await unlink(target); console.log('Agent service removed. Device configuration is preserved.'); return; }
    await readConfig();
    await mkdir(dirname(target), { recursive: true });
    const args = [process.execPath, resolve(process.argv[1]!), 'start', '--no-open', '--config', configPath];
    await writeFile(target, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>dev.public-queue.agent</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer></dict></plist>\n`, { mode: 0o600 });
    run('launchctl', ['bootstrap', domain, target]);
  } else if (process.platform === 'linux') {
    if (action === 'uninstall') { run('systemctl', ['--user', 'disable', '--now', 'public-queue-agent']); await unlink(join(homedir(), '.config/systemd/user/public-queue-agent.service')); run('systemctl', ['--user', 'daemon-reload']); console.log('Agent service removed. Device configuration is preserved.'); return; }
    await readConfig();
    const target = join(homedir(), '.config/systemd/user/public-queue-agent.service');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `[Unit]\nDescription=Public Queue local inference agent\nAfter=network-online.target\n[Service]\nExecStart=${[process.execPath, resolve(process.argv[1]!), 'start', '--headless', '--config', configPath].map(unitQuote).join(' ')}\nRestart=on-failure\nRestartSec=10\nUMask=0077\nNoNewPrivileges=true\n[Install]\nWantedBy=default.target\n`, { mode: 0o600 });
    run('systemctl', ['--user', 'daemon-reload']); run('systemctl', ['--user', 'enable', '--now', 'public-queue-agent']);
    console.log('For startup without an interactive login, enable lingering for this user (see deployment docs).');
  } else throw new Error('Automatic service installation supports macOS and Linux. On Windows run pq-agent start via Task Scheduler.');
  console.log('Agent service installed. Your model runtime must also be running.');
}
async function main(): Promise<void> {
  if (values.help || !positionals[0]) {
    console.log(`Public Queue · local models, durable jobs, no open ports\n\nCommands:\n  connect --server URL --code CODE [--runtime ollama|lmstudio|llama.cpp|omlx|vllm]\n          [--runtime-url http://127.0.0.1:8000/v1] [--models model-a,model-b]\n          [--allow-plaintext] [--config PATH]\n  start [--headless|--no-open]  Consume jobs; macOS dashboard and menu bar\n  gui [--no-open]  Local queue monitor and macOS menu bar (no inference)\n  doctor      Check the service, runtime and selected models\n  key         Print the pinned public key and fingerprint\n  service install|uninstall  Manage a macOS/Linux user service\n\nSet PQ_RUNTIME_KEY before connect if your local runtime requires authentication.\nE2E encryption is required by default. No inference server management endpoints are exposed.`); return;
  }
  if (positionals[0] === 'connect') { await connect(); return; }
  if (positionals[0] === 'service') { await service(positionals[1] ?? ''); return; }
  const config = await readConfig();
  if (positionals[0] === 'key') { console.log(`${config.publicKey}\nFingerprint: ${await fingerprint(config.publicKey)}`); return; }
  if (positionals[0] === 'doctor') {
    const health = await fetch(`${requireSecureUrl(config.server)}/health`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
    if (!health.ok) throw new Error(`Service health: HTTP ${health.status}`);
    const models = await discoverModels(config.runtimeUrl, config.runtimeKey);
    const missing = config.models.filter(model => !models.includes(model));
    if (missing.length) throw new Error(`Selected models not available: ${missing.join(', ')}`);
    console.log(`Service reachable. Runtime ready. ${config.models.length} allowed model(s).\nE2E ${config.allowPlaintext ? 'supported; plaintext also allowed' : 'required'}. Device authentication is checked when start runs.`); return;
  }
  if (!['start', 'gui'].includes(positionals[0]!)) throw new Error('Unknown command. Run pq-agent --help');
  const stop = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort());
  const consuming = positionals[0] === 'start';
  const showDashboard = !consuming || process.platform === 'darwin' && !values.headless;
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let stopMenuBar: (() => Promise<void>) | undefined;
  try {
    if (showDashboard) {
      dashboard = await startDashboard({ server: config.server, deviceId: config.deviceId, runtimeUrl: config.runtimeUrl, models: config.models, consuming,
        loadQueue: () => agentRequest<AgentQueue>(config.server, config.token, '/v1/agent/queue', undefined, stop.signal) });
      console.log(`Local dashboard: ${dashboard.url}`);
      if (process.platform === 'darwin' && !values.headless) {
        stopMenuBar = startMenuBar(dashboard.url, consuming, () => stop.abort(), () => console.log('Menu bar unavailable. Use the local dashboard link above.'));
      }
      if (process.platform === 'darwin' && !values.headless && !values['no-open']) {
        const opened = spawnSync('open', [dashboard.url], { stdio: 'ignore' });
        if (opened.error || opened.status !== 0) console.log('Open the dashboard link above in your browser.');
      }
    }
    if (!consuming) {
      console.log('Monitor only. Keep pq-agent start or the background service running to process jobs.');
      if (!stop.signal.aborted) await new Promise<void>(resolve => stop.signal.addEventListener('abort', () => resolve(), { once: true }));
      return;
    }
    const identity = await restoreIdentity(config.publicKey, config.privateKey as JsonWebKey);
    console.log(`Ready. ${config.models.length} allowed model(s). Waiting for jobs; relay connections are outbound only.`);
    const { runtimeKey, ...rest } = config;
    await runWorker({ ...rest, identity, ...(runtimeKey ? { runtimeKey } : {}), onStatus: status => console.log(status) }, stop.signal);
  } finally { stop.abort(); await stopMenuBar?.(); await dashboard?.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Agent failed'); process.exitCode = 1; });
