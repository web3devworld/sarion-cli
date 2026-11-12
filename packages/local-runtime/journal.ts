import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type * as P from '../agent-protocol/contracts.ts';
import { assert, hash, Failure, id } from '../agent-protocol/validation.ts';
import { privateDir } from '../platform/config.ts';
export class RecoveryJournal implements P.RecoveryJournal {
  readonly db: DatabaseSync;
  constructor(
    public directory: string,
    private key: Buffer,
  ) {
    privateDir(directory);
    const f = path.join(directory, 'recovery.sqlite');
    if (fs.existsSync(f)) {
      const st = fs.lstatSync(f);
      assert(
        st.isFile() && !st.isSymbolicLink() && (process.platform === 'win32' || (st.mode & 0o077) === 0),
        'Unsafe recovery database',
      );
    }
    this.db = new DatabaseSync(f);
    if (process.platform !== 'win32') fs.chmodSync(f, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get() as any;
    assert(version.user_version <= 1, 'Journal schema newer than client; refusing downgrade');
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS receipts(command_id TEXT PRIMARY KEY, hash TEXT NOT NULL, body TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY,body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,command_id TEXT NOT NULL,state TEXT NOT NULL,at INTEGER NOT NULL);
 PRAGMA user_version=1;`);
  }
  private seal(key: string, value: unknown): string {
    const iv = randomBytes(12),
      c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(key));
    return JSON.stringify({
      iv: iv.toString('hex'),
      data: Buffer.concat([c.update(JSON.stringify(value)), c.final()]).toString('base64'),
      tag: c.getAuthTag().toString('hex'),
    });
  }
  private unseal<T>(key: string, value: string): T {
    try {
      const v = JSON.parse(value),
        d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(v.iv, 'hex'));
      d.setAAD(Buffer.from(key));
      d.setAuthTag(Buffer.from(v.tag, 'hex'));
      return JSON.parse(Buffer.concat([d.update(Buffer.from(v.data, 'base64')), d.final()]).toString());
    } catch {
      throw new Failure('JOURNAL_UNREADABLE', 'Recovery key or journal is invalid; execution disabled', 5, true);
    }
  }
  put(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body')
      .run(key, this.seal(key, value));
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT body FROM kv WHERE key=?').get(key) as any;
    return row ? this.unseal<T>(key, row.body) : undefined;
  }
  keys(prefix: string): string[] {
    return (this.db.prepare('SELECT key FROM kv WHERE key LIKE ?').all(prefix + '%') as any[]).map((r) => r.key);
  }
  async append(r: P.JournalRecord): Promise<void> {
    this.db
      .prepare('INSERT INTO records VALUES(?,?,?,?,?)')
      .run(r.id, r.commandId, r.state, this.seal(r.commandId, r.body), r.at);
    this.audit(r.commandId, r.state);
  }
  record(command: string): P.JournalRecord | undefined {
    const r = this.db.prepare('SELECT * FROM records WHERE command_id=?').get(command) as any;
    return r
      ? { id: r.id, commandId: r.command_id, state: r.state, body: this.unseal(command, r.body), at: r.at }
      : undefined;
  }
  async transition(c: string, from: string, to: string, body: P.Json): Promise<void> {
    const r = this.db
      .prepare('UPDATE records SET state=?,body=?,at=? WHERE command_id=? AND state=?')
      .run(to, this.seal(c, body), Date.now(), c, from);
    assert(Number(r.changes) === 1, 'Invalid journal transition; no execution', 'EXECUTION_UNCERTAIN', 5);
    this.audit(c, to);
  }
  async pending(): Promise<P.JournalRecord[]> {
    return (
      this.db
        .prepare(
          "SELECT command_id FROM records WHERE state NOT IN ('acked','committed','denied','cancelled','abandoned')",
        )
        .all() as any[]
    ).map((r) => this.record(r.command_id)!);
  }
  async receipt(c: string): Promise<P.ExecutionReceipt | null> {
    const r = this.db.prepare('SELECT body FROM receipts WHERE command_id=?').get(c) as any;
    if (!r) return null;
    const value = this.unseal<P.ExecutionReceipt | { pruned: true }>(c, r.body);
    return 'pruned' in value ? null : value;
  }
  storeReceipt(r: P.ExecutionReceipt): void {
    const { receiptHash, ...body } = r;
    assert(hash(body) === receiptHash, 'Receipt hash mismatch');
    const old = this.db.prepare('SELECT hash FROM receipts WHERE command_id=?').get(r.commandId) as any;
    if (old) {
      assert(old.hash === receiptHash, 'Conflicting receipt', 'COMMAND_CONFLICT', 5);
      return;
    }
    this.db
      .prepare('INSERT INTO receipts(command_id,hash,body) VALUES(?,?,?)')
      .run(r.commandId, receiptHash, this.seal(r.commandId, r));
    this.audit(r.commandId, 'receipt_durable');
  }
  ack(c: string, h: string): void {
    const r = this.db.prepare('UPDATE receipts SET acked=1 WHERE command_id=? AND hash=?').run(c, h);
    assert(Number(r.changes) === 1, 'Invalid receipt ACK', 'EXECUTION_UNCERTAIN', 5);
    const rec = this.record(c);
    if (rec) this.db.prepare("UPDATE records SET state='acked' WHERE command_id=?").run(c);
    this.audit(c, 'acked');
  }
  outbox(): P.ExecutionReceipt[] {
    return (this.db.prepare('SELECT command_id,body FROM receipts WHERE acked=0').all() as any[]).map((r) =>
      this.unseal(r.command_id, r.body),
    );
  }
  async checkpoint(v: P.Checkpoint): Promise<void> {
    this.put('checkpoint:' + v.id, { ...v, createdAt: Date.now() });
  }
  audit(c: string, s: string): void {
    this.db.prepare('INSERT INTO audit(command_id,state,at) VALUES(?,?,?)').run(c, s, Date.now());
  }
  audits(n = 20): unknown[] {
    return this.db
      .prepare('SELECT command_id,state,at FROM audit ORDER BY seq DESC LIMIT ?')
      .all(Math.max(1, Math.min(n, 1000)));
  }
  async prune(now: number): Promise<{ removed: number; retainedUnresolved: number }> {
    const pending = await this.pending();
    let removed = 0;
    for (const row of this.db.prepare('SELECT command_id,body FROM receipts WHERE acked=1').all() as any[]) {
      const value = this.unseal<P.ExecutionReceipt | { pruned: true }>(row.command_id, row.body);
      if ('pruned' in value) continue;
      if (value.state === 'uncertain' && !this.get('disposition:' + value.parentCommandId)) continue;
      if (value.endedAt < now - 7 * 86400000) {
        this.db
          .prepare('UPDATE receipts SET body=? WHERE command_id=?')
          .run(this.seal(row.command_id, { pruned: true }), row.command_id);
        this.db.prepare('DELETE FROM kv WHERE key=?').run('claim:' + row.command_id);
        if (value.approvalDecisionId) {
          for (const key of ['plan:', 'approval:'])
            this.db.prepare('DELETE FROM kv WHERE key=?').run(key + value.approvalDecisionId);
        }
        removed++;
      }
    }
    for (const key of this.keys('checkpoint:')) {
      const cp = this.get<P.Checkpoint & { createdAt?: number }>(key)!;
      if ((cp.createdAt ?? now) > now - 30 * 86400000 || pending.some((r) => r.commandId === cp.commandId)) continue;
      const receipt = await this.receipt(cp.commandId);
      if (receipt?.state === 'uncertain' && !this.get('disposition:' + receipt.parentCommandId)) continue;
      for (const prefix of ['checkpoint:', 'patch:', 'patch-progress:', 'patch-uncertain:'])
        this.db.prepare('DELETE FROM kv WHERE key=?').run(prefix + cp.id);
      removed++;
    }
    const old = this.db
      .prepare(
        "SELECT command_id FROM records WHERE state IN ('acked','committed','denied','cancelled','abandoned') AND at<?",
      )
      .all(now - 30 * 86400000) as any[];
    for (const row of old)
      this.db
        .prepare('UPDATE records SET body=? WHERE command_id=?')
        .run(this.seal(row.command_id, { pruned: true }), row.command_id);
    this.db.prepare('DELETE FROM audit WHERE at<?').run(now - 30 * 86400000);
    return { removed: removed + old.length, retainedUnresolved: pending.length };
  }

  close(): void {
    this.db.close();
  }
}
