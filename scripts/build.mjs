import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile, cp, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir('dist/web', { recursive: true });
await Promise.all([
  build({ entryPoints: ['apps/web/src/app.ts'], outfile: 'dist/web/app.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true }),
  copyFile('apps/web/index.html', 'dist/web/index.html'),
  copyFile('apps/web/src/styles.css', 'dist/web/styles.css'),
  copyFile('apps/web/site/site.css', 'dist/web/site.css'),
  copyFile('apps/web/site/landing.css', 'dist/web/landing.css'),
  copyFile('apps/web/site/console.css', 'dist/web/console.css'),
  build({ entryPoints: ['apps/web/site/site.ts'], outfile: 'dist/web/site.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true }),
]);
for (const name of ['sdk', 'agent', 'server']) {
  const dir = `dist/packages/${name}`;
  await mkdir(dir, { recursive: true });
  const isSdk = name === 'sdk';
  await build({ entryPoints: [`packages/${name}/src/${isSdk ? 'index' : 'cli'}.ts`], outfile: `${dir}/${isSdk ? 'index' : 'cli'}.js`, bundle: true, format: 'esm', platform: isSdk ? 'browser' : 'node', target: isSdk ? 'es2022' : 'node24', minify: isSdk, ...(name === 'server' ? { packages: 'external' } : {}), ...(name === 'agent' ? { banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } } : {}) });
  if (!isSdk) await chmod(`${dir}/cli.js`, 0o755);
  if (name === 'agent') {
    await cp('packages/agent/native', `${dir}/native`, { recursive: true });
    await chmod(`${dir}/native/public-queue-menubar`, 0o755);
  }
  await cp('dist/types', `${dir}/types`, { recursive: true });
  const manifest = { name: `@public-queue/${name}`, version: '0.1.0', description: { sdk: 'Browser SDK for encrypted durable local inference jobs', agent: 'Outbound-only agent for local inference servers', server: 'Durable job service for local inference' }[name], type: 'module', license: 'MIT', repository: { type: 'git', url: 'git+https://github.com/lucamattiazzi/public-queue.git' }, homepage: 'https://github.com/lucamattiazzi/public-queue#readme', bugs: { url: 'https://github.com/lucamattiazzi/public-queue/issues' }, publishConfig: { access: 'public' }, ...(isSdk ? { main: './index.js', types: './types/sdk/src/index.d.ts', exports: { '.': { types: './types/sdk/src/index.d.ts', import: './index.js' } }, sideEffects: false, dependencies: { zod: root.dependencies.zod } } : { bin: { [`pq-${name}`]: 'cli.js' }, engines: { node: '>=24.0.0' }, ...(name === 'server' ? { dependencies: root.dependencies } : {}) }) };
  await writeFile(`${dir}/package.json`, JSON.stringify(manifest, null, 2) + '\n');
  for (const file of ['README.md', 'LICENSE']) await copyFile(file, `${dir}/${file}`);
  await cp('docs', `${dir}/docs`, { recursive: true });
  await cp('examples', `${dir}/examples`, { recursive: true, filter: source => !source.endsWith('/sdk.js') });
  await copyFile('Caddyfile', `${dir}/Caddyfile`);
}
await copyFile('dist/packages/sdk/index.js', 'dist/web/sdk.js');
console.log(`Built web console and packages in ${resolve('dist')}`);

for (const [route, source] of [['app', 'apps/web/console.html'], ['console', 'apps/web/console.html'], ['login', 'apps/web/site/login.html'], ['legal', 'apps/web/site/legal.html']]) {
  await mkdir(`dist/web/${route}`, { recursive: true });
  await copyFile(source, `dist/web/${route}/index.html`);
}
await mkdir('dist/web/downloads', { recursive: true });
for (const name of ['agent', 'sdk']) {
  execFileSync('tar', ['-czf', resolve(`dist/web/downloads/${name}.tgz`), '-C', 'dist/packages', name]);
}
execFileSync('tar', ['-czf', 'dist/web/downloads/source.tgz', '--exclude=.DS_Store', '--exclude=*.sqlite*', '--exclude=sdk.js', 'packages', 'apps', 'scripts', 'tests', 'docs', 'examples', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.build.json', 'Dockerfile', 'compose.yaml', 'compose.hetzner.yaml', 'Caddyfile', 'Caddyfile.docker', '.env.example', '.dockerignore', 'README.md', 'LICENSE']);
console.log('Built sales site, customer dashboard, and downloadable agent / SDK / source archives.');
