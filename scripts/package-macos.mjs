import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, cp, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';

if (process.platform !== 'darwin') throw new Error('Build the macOS app on a Mac with Xcode command-line tools.');
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const version = '0.3.0';
const nodeVersion = '24.19.0';
const cache = resolve('.data/macos-build');
const output = resolve('dist/macos');
const app = join(output, 'Public Queue.app');
const contents = join(app, 'Contents');
await mkdir(cache, { recursive: true });
await rm(app, { recursive: true, force: true });
for (const path of ['MacOS', 'Helpers', 'Resources/agent', 'Resources/Licenses']) await mkdir(join(contents, path), { recursive: true });
const base = `https://nodejs.org/dist/v${nodeVersion}`;
const sumsResponse = await fetch(`${base}/SHASUMS256.txt`);
if (!sumsResponse.ok) throw new Error(`Node checksums: HTTP ${sumsResponse.status}`);
const sums = await sumsResponse.text();
for (const arch of ['arm64', 'x64']) {
  const name = `node-v${nodeVersion}-darwin-${arch}.tar.gz`;
  const expected = sums.split('\n').find(line => line.endsWith(`  ${name}`))?.split(' ')[0];
  if (!expected) throw new Error(`Missing official SHA256 for ${name}`);
  const archive = join(cache, name);
  let bytes;
  try { bytes = await readFile(archive); } catch { /* First build downloads the pinned official runtime. */ }
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== expected) {
    const response = await fetch(`${base}/${name}`);
    if (!response.ok) throw new Error(`Node download: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Node checksum mismatch: ${name}`);
    await writeFile(archive, bytes);
  }
  run('tar', ['-xzf', archive, '-C', cache, `node-v${nodeVersion}-darwin-${arch}/bin/node`, `node-v${nodeVersion}-darwin-${arch}/LICENSE`]);
  run('xcrun', ['swiftc', '-O', '-target', `${arch === 'x64' ? 'x86_64' : arch}-apple-macosx14.0`, 'apps/macos/main.swift', 'apps/macos/Routing.swift', '-o', join(cache, `app-${arch}`)]);
}
run('xcrun', ['lipo', '-create', ...['arm64', 'x64'].map(arch => join(cache, `app-${arch}`)), '-output', join(contents, 'MacOS/PublicQueue')]);
run('xcrun', ['lipo', '-create', ...['arm64', 'x64'].map(arch => join(cache, `node-v${nodeVersion}-darwin-${arch}/bin/node`)), '-output', join(contents, 'Helpers/node')]);
await cp('dist/packages/agent/cli.js', join(contents, 'Resources/agent/cli.js'));
await writeFile(join(contents, 'Resources/agent/package.json'), '{"type":"module"}\n');
for (const [source, name] of [
  [join(cache, `node-v${nodeVersion}-darwin-arm64/LICENSE`), 'Node.txt'],
  ['LICENSE', 'Public-Queue.txt'], ['node_modules/undici/LICENSE', 'Undici.txt'], ['node_modules/zod/LICENSE', 'Zod.txt'],
]) await cp(source, join(contents, 'Resources/Licenses', name));
const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>it.grokked.public-queue</string>
<key>CFBundleName</key><string>Public Queue</string>
<key>CFBundleDisplayName</key><string>Public Queue</string>
<key>CFBundleExecutable</key><string>PublicQueue</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>CFBundleIconFile</key><string>AppIcon</string>
</dict></plist>`;
await writeFile(join(contents, 'Info.plist'), plist);
run('xcrun', ['swift', 'apps/macos/Icon.swift', cache]);
const iconset = join(cache, 'AppIcon.iconset');
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) run('sips', ['-z', String(size * scale), String(size * scale), join(cache, 'icon.png'), '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
}
run('iconutil', ['-c', 'icns', iconset, '-o', join(contents, 'Resources/AppIcon.icns')]);
const identity = process.env.PQ_MAC_SIGN_IDENTITY ?? '-';
const timestamp = identity === '-' ? [] : ['--timestamp'];
run('codesign', ['--force', '--sign', identity, '--options', 'runtime', ...timestamp, '--entitlements', 'apps/macos/Node.entitlements', join(contents, 'Helpers/node')]);
run('codesign', ['--force', '--sign', identity, '--options', 'runtime', ...timestamp, app]);
run('codesign', ['--verify', '--deep', '--strict', app]);
run('plutil', ['-lint', join(contents, 'Info.plist')]);
run(join(contents, 'MacOS/PublicQueue'), ['--check']);
run(join(contents, 'Helpers/node'), [join(contents, 'Resources/agent/cli.js'), '--help']);
const zip = join(output, `Public-Queue-${version}-macOS.zip`);
await rm(zip, { force: true });
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
if (process.env.PQ_MAC_NOTARY_PROFILE) {
  if (identity === '-') throw new Error('Notarization requires a Developer ID Application identity.');
  run('xcrun', ['notarytool', 'submit', zip, '--keychain-profile', process.env.PQ_MAC_NOTARY_PROFILE, '--wait']);
  run('xcrun', ['stapler', 'staple', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose', app]);
  await rm(zip); run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
}
const dmg = join(output, `Public-Queue-${version}-macOS.dmg`);
const staging = join(cache, 'dmg');
await rm(staging, { recursive: true, force: true }); await mkdir(staging);
await cp(app, join(staging, 'Public Queue.app'), { recursive: true });
run('ln', ['-s', '/Applications', join(staging, 'Applications')]);
await writeFile(join(staging, 'Install.txt'), 'Drag Public Queue to Applications, then open it once. Pair with your queue website to start the background agent. macOS 14 or later; Apple Silicon and Intel.\n');
await rm(dmg, { force: true });
run('hdiutil', ['create', '-volname', 'Public Queue', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg]);
if (identity !== '-') run('codesign', ['--sign', identity, '--timestamp', dmg]);
if (process.env.PQ_MAC_NOTARY_PROFILE) {
  run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', process.env.PQ_MAC_NOTARY_PROFILE, '--wait']);
  run('xcrun', ['stapler', 'staple', dmg]);
}
console.log(`macOS universal ${version}: ${dmg} (${Math.round((await stat(dmg)).size / 1024 / 1024)} MB)`);
console.log(identity === '-' ? 'LOCAL BUILD ONLY: ad-hoc signed, not notarized.' : process.env.PQ_MAC_NOTARY_PROFILE ? 'Developer-signed and notarized.' : 'Signed, but not notarized.');
