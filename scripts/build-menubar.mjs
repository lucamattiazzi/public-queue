import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
if (process.platform !== 'darwin') throw new Error('Rebuild the native helper on macOS with Xcode command-line tools. Linux builds use the checked-in universal binary.');
const dir = mkdtempSync(join(tmpdir(), 'pq-menubar-'));
const output = resolve('packages/agent/native/public-queue-menubar');
try {
  const slices = ['arm64', 'x86_64'].map(arch => {
    const path = join(dir, arch);
    execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macosx13.0`, 'packages/agent/native/MenuBar.swift', '-o', path], { stdio: 'inherit' });
    return path;
  });
  execFileSync('xcrun', ['lipo', '-create', ...slices, '-output', output]);
  chmodSync(output, 0o755);
  execFileSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--strict', output]);
  console.log('Built ad-hoc signed macOS 13+ helper for Apple Silicon and Intel.');
} finally { rmSync(dir, { recursive: true, force: true }); }
