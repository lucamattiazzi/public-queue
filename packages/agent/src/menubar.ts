import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

export function startMenuBar(url: string, consuming: boolean, onQuit: () => void, onUnavailable: () => void): () => Promise<void> {
  const directory = dirname(fileURLToPath(import.meta.url));
  const packaged = join(directory, 'native/public-queue-menubar');
  const executable = existsSync(packaged) ? packaged : join(directory, '../native/public-queue-menubar');
  const child = spawn(executable, [url, consuming ? 'agent' : 'monitor'], { stdio: ['pipe', 'pipe', 'ignore'] });
  let stopping = false;
  const closed = new Promise<void>(resolve => child.once('close', code => {
    if (!stopping && code !== 0) onUnavailable();
    resolve();
  }));
  child.once('error', () => { stopping = true; onUnavailable(); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { if (line === 'quit') { stopping = true; onQuit(); } });
  return async () => {
    stopping = true; child.stdin.end();
    child.kill('SIGTERM');
    await closed; lines.close();
  };
}
