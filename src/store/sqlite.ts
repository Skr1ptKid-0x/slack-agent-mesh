import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { OutputReceipt, TraceRecord } from '../core/types.js'
import type { Store, ThreadRecord } from './store.js'

/**
 * SQLite-backed {@link Store} using Node's built-in `node:sqlite`. No native
 * build step, no external service. Use a file path for durability across
 * restarts, or ':memory:' for tests and the credential-free demo.
 */
export class SqliteStore implements Store {
  private readonly db: DatabaseSync

  constructor(path = ':memory:') {
    // A file-backed store must be able to create its state file, which fails if
    // the parent directory (e.g. `.mesh/`) does not exist yet. Create it first.
    if (path !== ':memory:') {
      const dir = dirname(path)
      if (dir && dir !== '.') mkdirSync(dir, { recursive: true })
    }
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        seen_at  INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS traces (
        trace_id      TEXT PRIMARY KEY,
        channel       TEXT NOT NULL,
        root_ts       TEXT NOT NULL,
        hops          INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        status        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS visited (
        trace_id TEXT NOT NULL,
        agent    TEXT NOT NULL,
        PRIMARY KEY (trace_id, agent)
      );
      CREATE TABLE IF NOT EXISTS outputs (
        output_key TEXT PRIMARY KEY,
        trace_id   TEXT NOT NULL,
        channel    TEXT NOT NULL,
        ts         TEXT NOT NULL,
        status     TEXT NOT NULL DEFAULT 'posted',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delegations (
        deleg_key  TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        channel       TEXT NOT NULL,
        thread_ts     TEXT NOT NULL,
        primary_agent TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (channel, thread_ts)
      );
    `)
    // Backfill the `status` column for state files created before the pending-
    // claim guard existed. Throws (and is ignored) when the column is present.
    try {
      this.db.exec("ALTER TABLE outputs ADD COLUMN status TEXT NOT NULL DEFAULT 'posted';")
    } catch {
      /* column already exists */
    }
  }

  recordEvent(eventId: string): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO events (event_id, seen_at) VALUES (?, ?)')
      .run(eventId, Date.now())
    return res.changes === 1
  }

  getTrace(traceId: string): TraceRecord | undefined {
    const row = this.db.prepare('SELECT * FROM traces WHERE trace_id = ?').get(traceId) as
      | Record<string, unknown>
      | undefined
    if (!row) return undefined
    return {
      traceId: row.trace_id as string,
      channel: row.channel as string,
      rootTs: row.root_ts as string,
      hops: Number(row.hops),
      messageCount: Number(row.message_count),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      status: row.status as TraceRecord['status'],
    }
  }

  createTrace(rec: TraceRecord): void {
    this.db
      .prepare(
        `INSERT INTO traces
         (trace_id, channel, root_ts, hops, message_count, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.traceId,
        rec.channel,
        rec.rootTs,
        rec.hops,
        rec.messageCount,
        rec.createdAt,
        rec.updatedAt,
        rec.status,
      )
  }

  updateTrace(rec: TraceRecord): void {
    // root_ts is included so a trace whose root is bound late (a slash command
    // or multi-target turn establishes its thread root only on the first post)
    // can be persisted. Passing the existing rootTs is a harmless no-op.
    this.db
      .prepare(
        `UPDATE traces
         SET root_ts = ?, hops = ?, message_count = ?, updated_at = ?, status = ?
         WHERE trace_id = ?`,
      )
      .run(rec.rootTs, rec.hops, rec.messageCount, rec.updatedAt, rec.status, rec.traceId)
  }

  hasVisited(traceId: string, agent: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM visited WHERE trace_id = ? AND agent = ?')
      .get(traceId, agent)
    return row !== undefined
  }

  addVisited(traceId: string, agent: string): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO visited (trace_id, agent) VALUES (?, ?)')
      .run(traceId, agent)
    return res.changes === 1
  }

  getVisited(traceId: string): string[] {
    const rows = this.db
      .prepare('SELECT agent FROM visited WHERE trace_id = ? ORDER BY rowid')
      .all(traceId) as Array<{ agent: string }>
    return rows.map((r) => r.agent)
  }

  getOutput(outputKey: string): OutputReceipt | undefined {
    const row = this.db
      .prepare("SELECT * FROM outputs WHERE output_key = ? AND status = 'posted'")
      .get(outputKey) as Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      outputKey: row.output_key as string,
      traceId: row.trace_id as string,
      channel: row.channel as string,
      ts: row.ts as string,
      createdAt: Number(row.created_at),
    }
  }

  putOutput(receipt: OutputReceipt): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO outputs (output_key, trace_id, channel, ts, status, created_at)
         VALUES (?, ?, ?, ?, 'posted', ?)`,
      )
      .run(receipt.outputKey, receipt.traceId, receipt.channel, receipt.ts, receipt.createdAt)
  }

  claimOutput(input: { outputKey: string; channel: string; createdAt: number }): {
    claimed: boolean
  } {
    // node:sqlite runs synchronously, so this INSERT is atomic relative to any
    // other JS on the loop: the first caller inserts a pending row and wins; a
    // concurrent duplicate hits the PRIMARY KEY and is ignored (claimed=false).
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO outputs (output_key, trace_id, channel, ts, status, created_at)
         VALUES (?, '', ?, '', 'pending', ?)`,
      )
      .run(input.outputKey, input.channel, input.createdAt)
    return { claimed: res.changes === 1 }
  }

  finalizeOutput(receipt: OutputReceipt): void {
    this.db
      .prepare(
        `UPDATE outputs
         SET trace_id = ?, channel = ?, ts = ?, status = 'posted', created_at = ?
         WHERE output_key = ?`,
      )
      .run(receipt.traceId, receipt.channel, receipt.ts, receipt.createdAt, receipt.outputKey)
  }

  releaseOutput(outputKey: string): void {
    // Only pending claims are releasable; a finalized receipt is permanent.
    this.db
      .prepare("DELETE FROM outputs WHERE output_key = ? AND status = 'pending'")
      .run(outputKey)
  }

  recordDelegation(key: string): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO delegations (deleg_key, created_at) VALUES (?, ?)')
      .run(key, Date.now())
    return res.changes === 1
  }

  registerThread(channel: string, threadTs: string, primaryAgent: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO threads (channel, thread_ts, primary_agent, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(channel, threadTs, primaryAgent, Date.now())
  }

  getThread(channel: string, threadTs: string): ThreadRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM threads WHERE channel = ? AND thread_ts = ?')
      .get(channel, threadTs) as Record<string, unknown> | undefined
    if (!row) return undefined
    return {
      channel: row.channel as string,
      threadTs: row.thread_ts as string,
      primaryAgent: row.primary_agent as string,
      createdAt: Number(row.created_at),
    }
  }

  close(): void {
    this.db.close()
  }
}
