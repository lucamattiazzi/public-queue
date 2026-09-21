import { DatabaseSync } from 'node:sqlite';
import { existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Usage: node scripts/backup.mjs SOURCE.sqlite NEW_BACKUP.sqlite');
if (!existsSync(source)) throw new Error('Source database does not exist');
if (existsSync(destination)) throw new Error('Refusing to overwrite an existing backup');
const db = new DatabaseSync(resolve(source));
try { db.prepare('VACUUM INTO ?').run(resolve(destination)); chmodSync(destination, 0o600); }
finally { db.close(); }
console.log(`Backup written to ${resolve(destination)}`);
