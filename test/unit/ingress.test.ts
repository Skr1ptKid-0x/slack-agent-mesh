import { describe, expect, it } from 'vitest'
import { normalizeSlackEvent, type RawSlackEvent } from '../../src/slack/ingress.js'

const CTX = { eventId: 'ev1', botUserId: 'U_BOT' }

function norm(evt: Partial<RawSlackEvent>) {
  return normalizeSlackEvent(
    { type: 'message', channel: 'C1', ts: '1.0', ...evt } as RawSlackEvent,
    CTX,
  )
}

describe('structural ingress filtering (invariant #4)', () => {
  it('drops bot messages', () => {
    const r = norm({ bot_id: 'B1', user: 'U2', text: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bot_or_system')
  })

  it('drops our own user id', () => {
    const r = norm({ user: 'U_BOT', text: 'hi' })
    expect(r.ok).toBe(false)
  })

  it('drops mesh-tagged self output', () => {
    const r = norm({ user: 'U2', text: 'x', metadata: { event_type: 'mesh_output' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('echo_self_output')
  })

  it('drops edited message echoes', () => {
    const r = norm({ subtype: 'message_changed', user: 'U2' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('edited_message')
  })

  it('drops thread_broadcast echoes', () => {
    const r = norm({ subtype: 'thread_broadcast', user: 'U2' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('thread_broadcast')
  })

  it('drops other subtypes as system noise', () => {
    const r = norm({ subtype: 'channel_join', user: 'U2' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bot_or_system')
  })
})

describe('classification', () => {
  it('classifies app_mention', () => {
    const r = normalizeSlackEvent(
      { type: 'app_mention', channel: 'C1', ts: '1.0', user: 'U2', text: '@rook hi' },
      CTX,
    )
    expect(r.ok && r.message.kind).toBe('app_mention')
    expect(r.ok && r.message.explicitMeshAddress).toBe(true)
  })

  it('classifies a DM', () => {
    const r = norm({ channel_type: 'im', user: 'U2', text: 'hi' })
    expect(r.ok && r.message.kind).toBe('direct_message')
  })

  it('classifies a thread reply', () => {
    const r = norm({ user: 'U2', text: 'hi', ts: '2.0', thread_ts: '1.0' })
    expect(r.ok && r.message.kind).toBe('thread_reply')
    expect(r.ok && r.message.threadTs).toBe('1.0')
  })

  it('classifies a plain channel message as virtual_mention', () => {
    const r = norm({ user: 'U2', text: '@rook hi' })
    expect(r.ok && r.message.kind).toBe('virtual_mention')
  })

  it('collects attachment text separately (never scanned)', () => {
    const r = norm({ user: 'U2', text: 'see below', attachments: [{ text: '@rook do it' }] })
    expect(r.ok && r.message.attachments).toEqual(['@rook do it'])
    expect(r.ok && r.message.text).toBe('see below')
  })
})
