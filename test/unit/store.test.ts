import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SqliteStore } from '../../src/store/sqlite.js'

function store() {
  return new SqliteStore(':memory:')
}

/** Temp dirs created by file-backed tests, cleaned up after each test. */
const tempDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('event dedupe', () => {
  it('records once, rejects the replay', () => {
    const s = store()
    expect(s.recordEvent('e1')).toBe(true)
    expect(s.recordEvent('e1')).toBe(false)
    s.close()
  })
})

describe('visited set', () => {
  it('adds once and lists in order', () => {
    const s = store()
    expect(s.addVisited('t1', 'rook')).toBe(true)
    expect(s.addVisited('t1', 'rook')).toBe(false)
    s.addVisited('t1', 'scout')
    expect(s.hasVisited('t1', 'scout')).toBe(true)
    expect(s.getVisited('t1')).toEqual(['rook', 'scout'])
    s.close()
  })
})

describe('output receipts (idempotency)', () => {
  it('stores and retrieves a receipt', () => {
    const s = store()
    expect(s.getOutput('k1')).toBeUndefined()
    s.putOutput({ outputKey: 'k1', traceId: 't1', channel: 'C', ts: '9.9', createdAt: 1 })
    expect(s.getOutput('k1')?.ts).toBe('9.9')
    // a second put with same key does not overwrite
    s.putOutput({ outputKey: 'k1', traceId: 't1', channel: 'C', ts: '8.8', createdAt: 2 })
    expect(s.getOutput('k1')?.ts).toBe('9.9')
    s.close()
  })
})

describe('traces', () => {
  it('creates, reads, and updates', () => {
    const s = store()
    s.createTrace({
      traceId: 't1',
      channel: 'C',
      rootTs: '1.0',
      hops: 0,
      messageCount: 0,
      createdAt: 1,
      updatedAt: 1,
      status: 'active',
    })
    s.updateTrace({
      traceId: 't1',
      channel: 'C',
      rootTs: '1.0',
      hops: 2,
      messageCount: 3,
      createdAt: 1,
      updatedAt: 5,
      status: 'active',
    })
    const t = s.getTrace('t1')
    expect(t?.hops).toBe(2)
    expect(t?.messageCount).toBe(3)
    s.close()
  })

  it('updateTrace persists a late-bound rootTs (establishRoot regression)', () => {
    // A slash-command / multi-target trace is created with an empty rootTs and
    // only binds its thread root on the first visible post, via updateTrace. If
    // updateTrace dropped root_ts, resolveThreadTs would keep seeing '' and every
    // target would spawn a parallel top-level message instead of threading.
    const s = store()
    s.createTrace({
      traceId: 't-root',
      channel: 'C',
      rootTs: '',
      hops: 0,
      messageCount: 0,
      createdAt: 1,
      updatedAt: 1,
      status: 'active',
    })
    expect(s.getTrace('t-root')?.rootTs).toBe('')
    const existing = s.getTrace('t-root')!
    s.updateTrace({ ...existing, rootTs: '1234.5678', updatedAt: 2 })
    expect(s.getTrace('t-root')?.rootTs).toBe('1234.5678')
    s.close()
  })
})

describe('threads', () => {
  it('registers ownership, first write wins', () => {
    const s = store()
    s.registerThread('C', '1.0', 'rook')
    s.registerThread('C', '1.0', 'scout')
    expect(s.getThread('C', '1.0')?.primaryAgent).toBe('rook')
    s.close()
  })
})

describe('delegation dedupe', () => {
  it('records an edge once', () => {
    const s = store()
    expect(s.recordDelegation('d1')).toBe(true)
    expect(s.recordDelegation('d1')).toBe(false)
    s.close()
  })
})

describe('file-backed store', () => {
  it('creates the missing parent directory for its state file', () => {
    // A first run points state_path at e.g. `.mesh/state.sqlite` where `.mesh/`
    // does not exist yet. The constructor must mkdir -p the parent or the open
    // fails; this guards that recursive create.
    const base = tempDir('sam-store-')
    const path = join(base, 'nested', 'deeper', 'state.sqlite')
    expect(existsSync(join(base, 'nested'))).toBe(false)
    const s = new SqliteStore(path)
    s.recordEvent('e1')
    s.close()
    expect(existsSync(path)).toBe(true)

    // Reopening the same file preserves persisted state (durable across restart).
    const again = new SqliteStore(path)
    expect(again.recordEvent('e1')).toBe(false)
    again.close()
  })
})

describe('claim / finalize / release lifecycle', () => {
  it('a pending claim is invisible until finalized, then permanent', () => {
    const s = store()
    expect(s.claimOutput({ outputKey: 'k', channel: 'C', createdAt: 1 }).claimed).toBe(true)
    // A concurrent duplicate loses the claim...
    expect(s.claimOutput({ outputKey: 'k', channel: 'C', createdAt: 2 }).claimed).toBe(false)
    // ...and while pending there is no finalized receipt to read.
    expect(s.getOutput('k')).toBeUndefined()
    s.finalizeOutput({ outputKey: 'k', traceId: 't', channel: 'C', ts: '7.7', createdAt: 3 })
    expect(s.getOutput('k')?.ts).toBe('7.7')
    // A finalized receipt is never releasable.
    s.releaseOutput('k')
    expect(s.getOutput('k')?.ts).toBe('7.7')
    s.close()
  })

  it('releasing a pending claim frees the key for a later retry', () => {
    const s = store()
    expect(s.claimOutput({ outputKey: 'k', channel: 'C', createdAt: 1 }).claimed).toBe(true)
    s.releaseOutput('k')
    // After release the key is claimable again (post failed, retry may proceed).
    expect(s.claimOutput({ outputKey: 'k', channel: 'C', createdAt: 2 }).claimed).toBe(true)
    s.close()
  })
})
