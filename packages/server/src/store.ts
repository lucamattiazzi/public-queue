import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Assignment, Job, JobStatus, Payload, Submission, StreamPage } from '../../protocol/src/index.js';

import { Fault } from './errors.js';
export { Fault } from './errors.js';
import { Accounts } from './accounts.js';
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const secret = (): string => randomBytes(32).toString('base64url');
interface ProjectRow { id: string; name: string; require_encryption: number }
interface ClientRow { id: string; project_id: string; device_id: string; name: string }
interface DeviceRow { id: string; project_id: string; name: string; public_key: string | null; last_seen: number | null; revoked: number }
interface JobRow {
  id: string; project_id: string; client_id: string; device_id: string; status: JobStatus;
  payload: string | null; result: string | null; error: string | null; attempts: number;
  attempt_id: string | null; lease_until: number | null; created_at: number; updated_at: number; expires_at: number;
  request_hash: string; stream: number;
}
interface Options { ownerEmails?: string[]; clock?: () => number; leaseMs?: number; dailyLimit?: number; pendingLimit?: number; retentionMs?: number; storageLimitBytes?: number }
export class Store {
  private readonly db: DatabaseSync;
  readonly accounts: Accounts;
  private readonly ownerEmails: string[];
  private readonly now: () => number;
  readonly leaseMs: number;
  private readonly dailyLimit: number;
  private readonly pendingLimit: number;
  private readonly retentionMs: number;
  private readonly storageLimitBytes: number;
  constructor(path: string, options: Options = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 3) { this.db.close(); throw new Error('Database schema is newer than this server'); }
    this.now = options.clock ?? Date.now;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.dailyLimit = options.dailyLimit ?? 1000;
    this.pendingLimit = options.pendingLimit ?? 100;
    this.retentionMs = options.retentionMs ?? 7 * 86400_000;
    this.storageLimitBytes = options.storageLimitBytes ?? 256 * 1024 * 1024;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_hash TEXT NOT NULL UNIQUE, require_encryption INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
        pairing_hash TEXT UNIQUE, pairing_until INTEGER, token_hash TEXT UNIQUE, public_key TEXT, last_seen INTEGER, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), device_id TEXT NOT NULL REFERENCES devices(id),
        name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), client_id TEXT NOT NULL REFERENCES clients(id),
        device_id TEXT NOT NULL REFERENCES devices(id), status TEXT NOT NULL, payload TEXT, result TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        attempt_id TEXT, lease_until INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, request_hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(device_id, status, created_at);
      CREATE INDEX IF NOT EXISTS jobs_client ON jobs(client_id, created_at);
      CREATE INDEX IF NOT EXISTS jobs_quota ON jobs(project_id, created_at);
      CREATE TABLE IF NOT EXISTS usage(project_id TEXT NOT NULL REFERENCES projects(id), day INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(project_id,day));
      `);
    if (!(this.db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[]).some(column => column.name === 'stream')) this.db.exec('ALTER TABLE jobs ADD COLUMN stream INTEGER NOT NULL DEFAULT 0');
    this.db.exec('CREATE TABLE IF NOT EXISTS job_blocks(job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,attempt_id TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(job_id,attempt_id,sequence))');
    this.ownerEmails = (options.ownerEmails ?? []).map(email => email.trim().toLowerCase());
    this.accounts = new Accounts(this.db, this.now, () => this.createProject('My local AI').id, this.ownerEmails);
    this.db.exec('PRAGMA user_version=3');
  }
  close(): void { this.db.close(); }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createProject(name: string, requireEncryption = true): { id: string; ownerToken: string; name: string } {
    const id = randomUUID(), ownerToken = secret();
    this.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(id, name, hash(ownerToken), Number(requireEncryption));
    return { id, ownerToken, name };
  }
  owner(token: string): ProjectRow {
    const row = this.db.prepare('SELECT id,name,require_encryption FROM projects WHERE owner_hash=?').get(hash(token)) as unknown as ProjectRow | undefined;
    if (!row) throw new Fault('unauthorized', 401); return row;
  }
  project(id: string): ProjectRow {
    const row = this.db.prepare('SELECT id,name,require_encryption FROM projects WHERE id=?').get(id) as unknown as ProjectRow | undefined;
    if (!row) throw new Fault('not_found', 404); return row;
  }
  agent(token: string): DeviceRow {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash=? AND revoked=0').get(hash(token)) as unknown as DeviceRow | undefined;
    if (!row) throw new Fault('unauthorized', 401); return row;
  }
  client(token: string): ClientRow {
    const row = this.db.prepare('SELECT c.* FROM clients c JOIN devices d ON d.id=c.device_id WHERE c.token_hash=? AND c.revoked=0 AND d.revoked=0').get(hash(token)) as unknown as ClientRow | undefined;
    if (!row) throw new Fault('unauthorized', 401); return row;
  }
  createDevice(projectId: string, name: string): { id: string; pairingCode: string; expiresAt: number } {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE project_id=? AND revoked=0').get(projectId) as { n: number };
    if (this.accounts.plan(projectId)?.id !== 'owner' && count.n >= (this.accounts.plan(projectId)?.devices ?? 10)) throw new Fault('device_limit', 429);
    const id = randomUUID(), pairingCode = secret(), expiresAt = this.now() + 600_000;
    this.db.prepare('INSERT INTO devices(id,project_id,name,pairing_hash,pairing_until) VALUES(?,?,?,?,?)').run(id, projectId, name, hash(pairingCode), expiresAt);
    return { id, pairingCode, expiresAt };
  }
  pair(code: string, publicKey: string): { deviceId: string; token: string } {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT id FROM devices WHERE pairing_hash=? AND pairing_until>? AND revoked=0').get(hash(code), this.now()) as { id: string } | undefined;
      if (!row) throw new Fault('invalid_pairing', 401);
      const token = secret();
      this.db.prepare('UPDATE devices SET pairing_hash=NULL,pairing_until=NULL,token_hash=?,public_key=?,last_seen=? WHERE id=?').run(hash(token), publicKey, this.now(), row.id);
      return { deviceId: row.id, token };
    });
  }
  private deviceAvailable(projectId: string, deviceId: string): boolean {
    const plan = this.accounts.plan(projectId);
    if (!plan || plan.id === 'owner') return true;
    return Boolean(this.db.prepare('SELECT id FROM (SELECT id FROM devices WHERE project_id=? AND revoked=0 ORDER BY rowid LIMIT ?) WHERE id=?').get(projectId, plan.devices, deviceId));
  }
  private requireDeviceAvailable(deviceId: string): void {
    const device = this.db.prepare('SELECT project_id FROM devices WHERE id=? AND revoked=0').get(deviceId) as { project_id: string } | undefined;
    if (!device) throw new Fault('unauthorized', 401);
    if (!this.deviceAvailable(device.project_id, deviceId)) throw new Fault('plan_device_limit', 403);
  }
  devices(projectId: string): (DeviceRow & { available: boolean })[] {
    const rows = this.db.prepare('SELECT id,project_id,name,public_key,last_seen,revoked FROM devices WHERE project_id=? ORDER BY rowid DESC').all(projectId) as unknown as DeviceRow[];
    return rows.map(row => ({ ...row, available: !row.revoked && this.deviceAvailable(projectId, row.id) }));
  }
  createClient(projectId: string, deviceId: string, name: string): { id: string; token: string; deviceId: string } {
    if (!this.db.prepare('SELECT id FROM devices WHERE id=? AND project_id=? AND revoked=0').get(deviceId, projectId)) throw new Fault('not_found', 404);
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM clients WHERE project_id=? AND revoked=0').get(projectId) as { n: number };
    if (this.accounts.plan(projectId)?.id !== 'owner' && count.n >= (this.accounts.plan(projectId)?.clients ?? 100)) throw new Fault('client_limit', 429);
    const id = randomUUID(), token = secret();
    this.db.prepare('INSERT INTO clients(id,project_id,device_id,name,token_hash) VALUES(?,?,?,?,?)').run(id, projectId, deviceId, name, hash(token));
    return { id, token, deviceId };
  }
  clients(projectId: string): unknown[] {
    return this.db.prepare('SELECT id,device_id,name,revoked FROM clients WHERE project_id=?').all(projectId);
  }
  revoke(projectId: string, id: string, kind: 'device' | 'client'): void {
    this.transaction(() => {
      const table = kind === 'device' ? 'devices' : 'clients';
      const field = kind === 'device' ? 'device_id' : 'client_id';
      this.db.prepare(`DELETE FROM job_blocks WHERE job_id IN (SELECT id FROM jobs WHERE project_id=? AND ${field}=?)`).run(projectId, id);
      const result = this.db.prepare(`UPDATE ${table} SET revoked=1 WHERE id=? AND project_id=?`).run(id, projectId);
      if (!result.changes) throw new Fault('not_found', 404);
      this.db.prepare(`UPDATE jobs SET status='cancelled',payload=NULL,result=NULL,attempt_id=NULL,lease_until=NULL,updated_at=? WHERE ${field}=? AND status IN ('queued','running')`).run(this.now(), id);
    });
  }
  private clientById(id: string): ClientRow {
    const row = this.db.prepare('SELECT c.* FROM clients c JOIN devices d ON d.id=c.device_id WHERE c.id=? AND c.revoked=0 AND d.revoked=0').get(id) as unknown as ClientRow | undefined;
    if (!row) throw new Fault('unauthorized', 401); return row;
  }
  sweep(): void {
    const now = this.now();
    this.accounts.sweep();
    this.db.prepare("UPDATE jobs SET status='expired',payload=NULL,result=NULL,attempt_id=NULL,lease_until=NULL,error='deadline_exceeded',updated_at=? WHERE status IN ('queued','running') AND expires_at<=?").run(now, now);
    this.db.prepare("UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error=CASE WHEN attempts>=3 THEN 'attempts_exhausted' ELSE NULL END,payload=CASE WHEN attempts>=3 THEN NULL ELSE payload END,attempt_id=NULL,lease_until=NULL,updated_at=? WHERE status='running' AND lease_until<=?").run(now, now);
    this.db.prepare("DELETE FROM jobs WHERE status NOT IN ('queued','running') AND project_id NOT IN (SELECT project_id FROM accounts WHERE email IN (SELECT value FROM json_each(?))) AND updated_at < ? - COALESCE((SELECT CASE WHEN a.paid_until>? THEN 604800000 ELSE 86400000 END FROM accounts a WHERE a.project_id=jobs.project_id),?)").run(JSON.stringify(this.ownerEmails), now, now, this.retentionMs);
    this.db.prepare("DELETE FROM job_blocks WHERE job_id IN (SELECT id FROM jobs WHERE status IN ('expired','cancelled'))").run();
    this.db.prepare('DELETE FROM usage WHERE day<?').run(Math.floor(now / 86400_000) - 62);
  }
  submit(clientId: string, submission: Submission): Job {
    return this.transaction(() => {
      this.sweep();
      const client = this.clientById(clientId);
      const requestHash = hash(JSON.stringify([submission.payload, submission.ttlSeconds, ...(submission.stream ? [true] : [])]));
      const existing = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(submission.id) as unknown as JobRow | undefined;
      if (existing) {
        if (existing.client_id !== clientId || existing.request_hash !== requestHash) throw new Fault('idempotency_conflict', 409);
        return this.view(existing);
      }
      this.requireDeviceAvailable(client.device_id);
      const clientPlan = this.accounts.plan(client.project_id);
      if (clientPlan && clientPlan.id !== 'owner' && !this.db.prepare('SELECT id FROM (SELECT id FROM clients WHERE project_id=? AND revoked=0 ORDER BY rowid LIMIT ?) WHERE id=?').get(client.project_id, clientPlan.clients, clientId)) throw new Fault('plan_client_limit', 403);
      const project = this.db.prepare('SELECT require_encryption FROM projects WHERE id=?').get(client.project_id) as { require_encryption: number };
      if (project.require_encryption && submission.payload.mode !== 'encrypted') throw new Fault('encryption_required');
      const plan = this.accounts.plan(client.project_id);
      if (plan && plan.id !== 'owner' && this.accounts.usage(client.project_id).month >= plan.monthlyJobs) throw new Fault('monthly_quota_exceeded', 429);
      const pending = this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE project_id=? AND status IN ('queued','running')").get(client.project_id) as { n: number };
      const day = Math.floor(this.now() / 86400_000);
      const usage = this.db.prepare('SELECT count FROM usage WHERE project_id=? AND day=?').get(client.project_id, day) as { count: number } | undefined;
      if (plan?.id !== 'owner' && (pending.n >= (plan?.pendingJobs ?? this.pendingLimit) || (usage?.count ?? 0) >= (plan?.dailyJobs ?? this.dailyLimit))) throw new Fault('quota_exceeded', 429);
      // Reserve more than the maximum HTTP result body for every unfinished job.
      const storage = this.db.prepare("SELECT COALESCE(SUM(CASE WHEN status IN ('queued','running') THEN CASE WHEN stream=1 THEN 4000000 ELSE 2000000 END ELSE COALESCE(length(CAST(result AS BLOB)),0) + COALESCE((SELECT SUM(length(CAST(b.payload AS BLOB))) FROM job_blocks b WHERE b.job_id=jobs.id),0) END),0) AS bytes FROM jobs WHERE project_id=?").get(client.project_id) as { bytes: number };
      if (plan?.id !== 'owner' && storage.bytes + (submission.stream ? 4_000_000 : 2_000_000) > (plan?.storageBytes ?? this.storageLimitBytes)) throw new Fault('storage_quota_exceeded', 429);
      const now = this.now();
      this.db.prepare("INSERT INTO jobs(id,project_id,client_id,device_id,status,payload,created_at,updated_at,expires_at,request_hash,stream) VALUES(?,?,?,?,'queued',?,?,?,?,?,?)").run(submission.id, client.project_id, clientId, client.device_id, JSON.stringify(submission.payload), now, now, now + Math.min(submission.ttlSeconds, (plan?.retentionDays ?? 7) * 86400) * 1000, requestHash, Number(submission.stream ?? false));
      this.db.prepare('INSERT INTO usage VALUES(?,?,1) ON CONFLICT(project_id,day) DO UPDATE SET count=count+1').run(client.project_id, day);
      return this.getJob(clientId, submission.id);
    });
  }
  claim(deviceId: string): Assignment | null {
    return this.transaction(() => {
      this.sweep();
      this.requireDeviceAvailable(deviceId);
      this.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(this.now(), deviceId);
      if (this.db.prepare("SELECT id FROM jobs WHERE device_id=? AND status='running'").get(deviceId)) return null;
      const row = this.db.prepare("SELECT * FROM jobs WHERE device_id=? AND status='queued' ORDER BY created_at,rowid LIMIT 1").get(deviceId) as unknown as JobRow | undefined;
      if (!row) return null;
      this.db.prepare('DELETE FROM job_blocks WHERE job_id=?').run(row.id);
      const attemptId = randomUUID();
      this.db.prepare("UPDATE jobs SET status='running',attempts=attempts+1,attempt_id=?,lease_until=?,updated_at=? WHERE id=?").run(attemptId, this.now() + this.leaseMs, this.now(), row.id);
      return { ...this.view({ ...row, status: 'running', attempts: row.attempts + 1, updated_at: this.now() }), payload: JSON.parse(row.payload!) as Payload, attemptId, leaseMs: this.leaseMs };
    });
  }
  heartbeat(deviceId: string, id: string, attemptId: string): void {
    const now = this.now();
    const result = this.db.prepare("UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND device_id=? AND attempt_id=? AND status='running' AND lease_until>? AND expires_at>?").run(now + this.leaseMs, now, id, deviceId, attemptId, now, now);
    if (!result.changes) throw new Fault('lease_lost', 409);
    this.db.prepare('UPDATE devices SET last_seen=? WHERE id=?').run(now, deviceId);
  }
  append(deviceId: string, id: string, attemptId: string, sequence: number, payload: Payload): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id=? AND device_id=?').get(id, deviceId) as unknown as JobRow | undefined;
      if (!row || row.status !== 'running' || row.attempt_id !== attemptId || row.lease_until! <= this.now() || row.expires_at <= this.now()) throw new Fault('lease_lost', 409);
      if (!row.stream) throw new Fault('stream_not_requested');
      if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 2048) throw new Fault('stream_sequence');
      const request = JSON.parse(row.payload!) as Payload;
      if (request.mode !== payload.mode) throw new Fault('encryption_mode_mismatch');
      if (payload.mode === 'encrypted') {
        const device = this.db.prepare('SELECT public_key FROM devices WHERE id=?').get(deviceId) as { public_key: string };
        if (payload.data.publicKey !== device.public_key) throw new Fault('identity_mismatch');
      }
      const encoded = JSON.stringify(payload);
      if (Buffer.byteLength(encoded) > 16384) throw new Fault('stream_block_too_large', 413);
      const existing = this.db.prepare('SELECT payload FROM job_blocks WHERE job_id=? AND attempt_id=? AND sequence=?').get(id, attemptId, sequence) as { payload: string } | undefined;
      if (existing) { if (existing.payload !== encoded) throw new Fault('stream_conflict', 409); return; }
      const totals = this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS last,COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS bytes FROM job_blocks WHERE job_id=? AND attempt_id=?').get(id, attemptId) as { last: number; bytes: number };
      if (sequence !== totals.last + 1) throw new Fault('stream_sequence', 409);
      if (totals.bytes + Buffer.byteLength(encoded) > 2_000_000) throw new Fault('stream_budget_exceeded', 413);
      this.db.prepare('INSERT INTO job_blocks VALUES(?,?,?,?)').run(id, attemptId, sequence, encoded);
    });
  }
  events(clientId: string, id: string, attemptId: string | null, after: number): StreamPage {
    const job = this.getJob(clientId, id);
    const current = this.db.prepare('SELECT attempt_id FROM jobs WHERE id=?').get(id) as { attempt_id: string | null };
    const rows = this.db.prepare('SELECT sequence,payload FROM job_blocks WHERE job_id=? AND attempt_id=? AND sequence>? ORDER BY sequence LIMIT 65').all(id, current.attempt_id, attemptId === current.attempt_id ? after : 0) as unknown as { sequence: number; payload: string }[];
    return { job, attemptId: current.attempt_id, events: rows.slice(0, 64).map(row => ({ sequence: row.sequence, payload: JSON.parse(row.payload) as Payload })), hasMore: rows.length > 64 };
  }
  finish(deviceId: string, id: string, attemptId: string, result: Payload, success: boolean): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM jobs WHERE id=? AND device_id=?').get(id, deviceId) as unknown as JobRow | undefined;
      // Completion retries after a lost HTTP response are safe, but cannot replace the result.
      const encoded = JSON.stringify(result);
      if (row?.attempt_id === attemptId && row.status === (success ? 'succeeded' : 'failed') && row.result === encoded) return;
      if (!row || row.status !== 'running' || row.attempt_id !== attemptId || row.lease_until! <= this.now() || row.expires_at <= this.now()) throw new Fault('lease_lost', 409);
      const request = JSON.parse(row.payload!) as Payload;
      if (request.mode !== result.mode) throw new Fault('encryption_mode_mismatch');
      if (result.mode === 'encrypted') {
        const device = this.db.prepare('SELECT public_key FROM devices WHERE id=?').get(deviceId) as { public_key: string };
        if (result.data.publicKey !== device.public_key) throw new Fault('identity_mismatch');
      }
      this.db.prepare('UPDATE jobs SET status=?,result=?,payload=NULL,error=?,lease_until=NULL,updated_at=? WHERE id=?').run(success ? 'succeeded' : 'failed', encoded, success ? null : 'inference_failed', this.now(), id);
    });
  }
  getJob(clientId: string, id: string): Job {
    this.sweep();
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=? AND client_id=?').get(id, clientId) as unknown as JobRow | undefined;
    if (!row) throw new Fault('not_found', 404); return this.view(row);
  }
  jobs(clientId: string): Job[] {
    this.sweep();
    return (this.db.prepare('SELECT * FROM jobs WHERE client_id=? ORDER BY created_at DESC LIMIT 100').all(clientId) as unknown as JobRow[]).map(row => this.view(row));
  }
  cancel(clientId: string, id: string): Job {
    this.getJob(clientId, id);
    this.db.prepare("UPDATE jobs SET status='cancelled',payload=NULL,result=NULL,attempt_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND client_id=? AND status IN ('queued','running')").run(this.now(), id, clientId);
    this.db.prepare("DELETE FROM job_blocks WHERE job_id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='cancelled')").run(id, id);
    return this.getJob(clientId, id);
  }
  private view(row: JobRow): Job {
    return { id: row.id, stream: Boolean(row.stream), deviceId: row.device_id, status: row.status, attempts: row.attempts, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at, result: row.result ? JSON.parse(row.result) as Payload : null, error: row.error };
  }
}
