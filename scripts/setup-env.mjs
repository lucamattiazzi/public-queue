import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const example = await readFile('.env.example', 'utf8');
await writeFile('.env', example.replace('PQ_ADMIN_TOKEN=\n', `PQ_ADMIN_TOKEN=${randomBytes(32).toString('hex')}\n`), { flag: 'wx', mode: 0o600 });
console.log('Created private .env with an administrator secret. Edit domain, operator, SMTP and Stripe fields; never commit this file.');
