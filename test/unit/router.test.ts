import { describe, expect, it } from 'vitest'
import { validateConfig } from '../../src/config/load.js'
import { Logger } from '../../src/core/logger.js'
import { Router } from '../../src/core/router.js'
import type { IngressMessage } from '../../src/core/types.js'
import { SqliteStore } from '../../src/store/sqlite.js'

function setup(overrides?: { maxHops?: number; maxMessages?: number; ttl?: number }) {
  const config = validateConfig({
    mesh: {
      max_hops: overrides?.maxHops ?? 4,
      max_messages: overrides?.maxMessages ?? 12,
      trace_ttl_seconds: overrides?.ttl ?? 3600,
      state_path: ':memory:',
    },
    agents: [
      { name: 'rook', adapter: { type: 'mock', reply: '' } },
      { name: 'scout', adapter: { type: 'mock', reply: '' } },
    ],
  })
  const store = new SqliteStore(':memory:')
  const logger = new Logger({ level: 'error', sink: () => {} })
  let seq = 0
  const now = { value: 1000 }
  const router = new Router(config, store, logger, {
    newId: () => `trc_${++seq}`,
    now: () => now.value,
  })
  return { router, store, now }
}

function human(partial: Partial<IngressMessage>): IngressMessage {
  return {
    eventId: partial.eventId ?? 'e1',
    kind: partial.kind ?? 'app_mention',
    actor: 'human',
    senderId: 'U1',
    channel: 'C1',
    threadTs: partial.threadTs ?? '1.0',
    ts: '1.0',
    text: partial.text ?? '',
    ...partial,
  }
}

describe('human admission', () => {
  it('admits an app_mention naming a known agent', () => {
    const { router } = setup()
    const d = router.admit(human({ text: '@rook help' }))
    expect(d.admit).toBe(true)
    expect(d.targets).toEqual(['rook'])
    expect(d.reason).toBe('app_mention')
  })

  it('rejects a duplicate event id (dedupe)', () => {
    const { router } = setup()
    router.admit(human({ eventId: 'dup', text: '@rook a' }))
    const d = router.admit(human({ eventId: 'dup', text: '@rook a' }))
    expect(d.admit).toBe(false)
    expect(d.reason).toBe('duplicate_event')
  })

  it('reports unknown agent for an addressed message', () => {
    const { router } = setup()
    const d = router.admit(human({ text: '@ghost hello' }))
    expect(d.admit).toBe(false)
    expect(d.reason).toBe('unknown_agent')
    expect(d.unknownMentions).toEqual(['ghost'])
  })

  it('reports no_target when addressed with no agent mention', () => {
    const { router } = setup()
    const d = router.admit(human({ text: 'hello there' }))
    expect(d.reason).toBe('no_target')
  })

  it('ignores plain channel chatter (virtual_mention with no known agent)', () => {
    const { router } = setup()
    const d = router.admit(human({ kind: 'virtual_mention', text: 'hey @ghost' }))
    expect(d.admit).toBe(false)
    expect(d.reason).toBe('not_addressed')
  })

  it('does not delegate on mentions inside code fences', () => {
    const { router } = setup()
    const d = router.admit(human({ text: 'look:\n```\n@rook run\n```' }))
    expect(d.admit).toBe(false)
  })

  it('rejects a thread reply in a thread the mesh does not own', () => {
    const { router } = setup()
    const d = router.admit(human({ kind: 'thread_reply', threadTs: '9.9', text: 'more' }))
    expect(d.reason).toBe('not_addressed')
  })

  it('admits a thread reply in an owned thread, defaulting to primary agent', () => {
    const { router, store } = setup()
    store.registerThread('C1', '5.0', 'scout')
    const d = router.admit(human({ kind: 'thread_reply', threadTs: '5.0', text: 'continue' }))
    expect(d.admit).toBe(true)
    expect(d.targets).toEqual(['scout'])
  })
})

describe('delegation admission (invariant #4)', () => {
  function seededTrace() {
    const ctx = setup()
    const d = ctx.router.admit(human({ text: '@rook go' }))
    const traceId = d.traceId as string
    // Reserve rook's turn so it is marked visited / counted.
    ctx.router.reserveTurn({
      traceId,
      agent: 'rook',
      prompt: '',
      channel: 'C1',
      threadTs: '1.0',
      causeEventId: 'e1',
      hop: 0,
    })
    return { ...ctx, traceId }
  }

  it('admits rook -> scout', () => {
    const { router, traceId } = seededTrace()
    const d = router.admitDelegation({
      traceId,
      fromAgent: 'rook',
      toAgent: 'scout',
      causeEventId: 'src1',
      sourceHop: 0,
    })
    expect(d.admit).toBe(true)
    expect(d.target).toBe('scout')
    expect(d.hop).toBe(1)
  })

  it('blocks a self-mention', () => {
    const { router, traceId } = seededTrace()
    const d = router.admitDelegation({
      traceId,
      fromAgent: 'rook',
      toAgent: 'rook',
      causeEventId: 's',
      sourceHop: 0,
    })
    expect(d.reason).toBe('self_mention')
  })

  it('blocks a revisit (rook -> scout -> rook)', () => {
    const { router, traceId } = seededTrace()
    const d = router.admitDelegation({
      traceId,
      fromAgent: 'scout',
      toAgent: 'rook',
      causeEventId: 's',
      sourceHop: 1,
    })
    expect(d.reason).toBe('already_visited')
  })

  it('blocks an unknown agent', () => {
    const { router, traceId } = seededTrace()
    const d = router.admitDelegation({
      traceId,
      fromAgent: 'rook',
      toAgent: 'ghost',
      causeEventId: 's',
      sourceHop: 0,
    })
    expect(d.reason).toBe('unknown_agent')
  })

  it('blocks beyond max_hops', () => {
    const { router, traceId } = setup2(1)
    const d = router.admitDelegation({
      traceId,
      fromAgent: 'rook',
      toAgent: 'scout',
      causeEventId: 's',
      sourceHop: 1, // -> hop 2 > max 1
    })
    expect(d.reason).toBe('hop_limit')
  })

  it('blocks beyond max_messages', () => {
    const { router, traceId } = setup2(4, 1)
    const d = router.admitDelegation({
      traceId,
      fromAgent: 'rook',
      toAgent: 'scout',
      causeEventId: 's',
      sourceHop: 0,
    })
    expect(d.reason).toBe('message_budget')
  })

  it('blocks an expired trace', () => {
    const ctx = setup({ ttl: 1 })
    const d0 = ctx.router.admit(human({ text: '@rook go' }))
    const traceId = d0.traceId as string
    ctx.router.reserveTurn({
      traceId,
      agent: 'rook',
      prompt: '',
      channel: 'C1',
      threadTs: '1.0',
      causeEventId: 'e1',
      hop: 0,
    })
    ctx.now.value += 5000 // advance beyond 1s ttl
    const d = ctx.router.admitDelegation({
      traceId,
      fromAgent: 'rook',
      toAgent: 'scout',
      causeEventId: 's',
      sourceHop: 0,
    })
    expect(d.reason).toBe('trace_expired')
  })

  it('collapses a duplicate delegation edge', () => {
    const { router, traceId } = seededTrace()
    const edge = {
      traceId,
      fromAgent: 'rook',
      toAgent: 'scout',
      causeEventId: 'same',
      sourceHop: 0,
    }
    expect(router.admitDelegation(edge).admit).toBe(true)
    expect(router.admitDelegation(edge).reason).toBe('duplicate_event')
  })
})

// Helper to seed a trace where rook already ran, with custom limits.
function setup2(maxHops: number, maxMessages = 12) {
  const ctx = setup({ maxHops, maxMessages })
  const d = ctx.router.admit(human({ text: '@rook go' }))
  const traceId = d.traceId as string
  ctx.router.reserveTurn({
    traceId,
    agent: 'rook',
    prompt: '',
    channel: 'C1',
    threadTs: '1.0',
    causeEventId: 'e1',
    hop: 0,
  })
  return { ...ctx, traceId }
}
