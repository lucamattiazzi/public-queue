import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const run = (cmd, args, cwd = process.cwd()) => {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) throw new Error(`${cmd} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
mkdirSync('dist/tarballs', { recursive: true });
const artifacts = resolve('dist/tarballs');
for (const name of ['sdk', 'agent']) run('pnpm', ['pack', '--pack-destination', artifacts], resolve(`dist/packages/${name}`));
const consumer = mkdtempSync(join(tmpdir(), 'pq-consumer-'));
try {
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...['sdk', 'agent'].map(name => resolve(`dist/web/downloads/${name}.tgz`))], consumer);
  writeFileSync(join(consumer, 'consumer.mts'), `import { PublicQueue, type ChatResult } from '@public-queue/sdk';\nconst client = new PublicQueue({server:'http://127.0.0.1:8787',token:'test',deviceId:'test',publicKey:'test'});\nconst result: Promise<ChatResult> = client.wait('some-id');\nvoid result;\n`);
  run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--skipLibCheck', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2023,DOM', 'consumer.mts'], consumer);
  const help = run(join(consumer, 'node_modules/.bin/pq-agent'), ['--help'], consumer);
  if (!help.includes('connect --server')) throw new Error('Agent binary did not run');
  const native = join(consumer, 'node_modules/@public-queue/agent/native/public-queue-menubar');
  if (!statSync(native).isFile()) throw new Error('Native menu bar helper missing from agent package');
  if (process.platform === 'darwin' && !run(native, ['--check'], consumer).includes('Public Queue')) throw new Error('Packaged native helper did not run');
  const imports = run(process.execPath, ['--input-type=module', '-e', "import { PublicQueue, createOpenAIFetch, createUIMessageFetch } from '@public-queue/sdk'; if([PublicQueue, createOpenAIFetch, createUIMessageFetch].some(value => typeof value !== 'function')) process.exit(1)"], consumer);
  console.log('Installed SDK and agent tarballs in an isolated consumer. Imports, types and CLI passed.');
} finally { rmSync(consumer, { recursive: true, force: true }); }
