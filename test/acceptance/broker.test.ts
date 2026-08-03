import { describe, expect, it } from 'vitest'
import { createHarness, failingAdapter, recordingAdapter } from '../helpers/harness.js'

const ROOT = '1000.000000'

describe('positive: directed admission and single reply', () => {
  it('human invokes @rook; rook runs once and posts one threaded reply', async () => {
    const h = createHarness({ agents: [{ name: 'rook', reply: 'On it.' }, { name: 'scout' }] })
    await h.sendSlack({ type: 'app_mention', text: '@rook check the deploy', ts: ROOT })
    expect(h.gateway.posts).toHaveLength(1)
    const post = h.gateway.posts[0]!
    expect(post.text).toContain('@rook')
    expect(post.threadTs).toBe(ROOT)
    h.close()
  })

  it('rook delegates to @scout; scout runs once in the same trace and thread', async () => {
    const h = createHarness({
      agents: [
        { name: 'rook', reply: 'Investigating. @scout please pull logs.' },
        { name: 'scout', reply: 'Found the bad deploy.' },
      ],
    })
    await h.sendSlack({ type: 'app_mention', text: '@rook 500s in prod', ts: ROOT })
    expect(h.gateway.posts).toHaveLength(2)
    expect(h.gateway.posts.every((p) => p.threadTs === ROOT)).toBe(true)
    // Same trace: both agents recorded under one trace id.
    const traceId = h.gateway.posts[0]!.metadata!.traceId
    expect(h.gateway.posts[1]!.metadata!.traceId).toBe(traceId)
    expect(h.mesh.store.getVisited(traceId)).toEqual(['rook', 'scout'])
    h.close()
  })

  it('routes /mesh, DM, and active-thread follow-up', async () => {
    const h = createHarness({ agents: [{ name: 'rook', reply: 'ack' }] })

    // Slash command (no thread anchor).
    await h.sendIngress({
      eventId: 'slash-1',
      kind: 'slash_command',
      actor: 'human',
      senderId: 'U1',
      channel: 'C1',
      threadTs: '',
      ts: '',
      text: '@rook via slash',
      explicitMeshAddress: true,
    })
    expect(h.gateway.posts).toHaveLength(1)

    // DM.
    await h.sendSlack({ type: 'message', channel_type: 'im', text: '@rook via dm', ts: '2000.0' })
    expect(h.gateway.posts).toHaveLength(2)

    // App mention establishes an owned thread, then a follow-up with no mention.
    await h.sendSlack({ type: 'app_mention', text: '@rook start', ts: '3000.0' })
    expect(h.gateway.posts).toHaveLength(3)
    await h.sendSlack({
      type: 'message',
      text: 'and now continue',
      ts: '3001.0',
      thread_ts: '3000.0',
    })
    expect(h.gateway.posts).toHaveLength(4)
    expect(h.gateway.posts[3]!.threadTs).toBe('3000.0')
    h.close()
  })
})

describe('adversarial: no recursive storms', () => {
  it('the same event_id delivered twice invokes zero additional turns', async () => {
    const rook = recordingAdapter('rook', 'ack')
    const h = createHarness({ agents: [{ name: 'rook', adapter: rook }] })
    await h.sendSlack({ type: 'app_mention', text: '@rook once', ts: ROOT, eventId: 'dup-1' })
    await h.sendSlack({ type: 'app_mention', text: '@rook once', ts: ROOT, eventId: 'dup-1' })
    expect(rook.prompts).toHaveLength(1)
    expect(h.gateway.posts).toHaveLength(1)
    h.close()
  })

  it('rook mentioning rook does not recurse', async () => {
    const rook = recordingAdapter('rook', 'looping @rook again')
    const h = createHarness({ agents: [{ name: 'rook', adapter: rook }] })
    await h.sendSlack({ type: 'app_mention', text: '@rook go', ts: ROOT })
    expect(rook.prompts).toHaveLength(1)
    expect(h.gateway.posts).toHaveLength(1)
    h.close()
  })

  it('rook -> scout -> rook is blocked by the visited set', async () => {
    const rook = recordingAdapter('rook', 'delegating @scout')
    const scout = recordingAdapter('scout', 'back to @rook')
    const h = createHarness({
      agents: [
        { name: 'rook', adapter: rook },
        { name: 'scout', adapter: scout },
      ],
    })
    await h.sendSlack({ type: 'app_mention', text: '@rook go', ts: ROOT })
    expect(rook.prompts).toHaveLength(1)
    expect(scout.prompts).toHaveLength(1)
    expect(h.gateway.posts).toHaveLength(2)
    h.close()
  })

  it('a chain beyond max_hops is blocked', async () => {
    const owl = recordingAdapter('owl', 'end')
    const h = createHarness({
      maxHops: 1,
      agents: [
        { name: 'rook', reply: 'to @scout' },
        { name: 'scout', reply: 'to @owl' },
        { name: 'owl', adapter: owl },
      ],
    })
    await h.sendSlack({ type: 'app_mention', text: '@rook go', ts: ROOT })
    expect(h.gateway.posts).toHaveLength(2) // rook (hop0) + scout (hop1); owl (hop2) blocked
    expect(owl.prompts).toHaveLength(0)
    h.close()
  })

  it('a trace beyond max_messages is blocked', async () => {
    const owl = recordingAdapter('owl', 'end')
    const h = createHarness({
      maxMessages: 2,
      agents: [
        { name: 'rook', reply: 'to @scout' },
        { name: 'scout', reply: 'to @owl' },
        { name: 'owl', adapter: owl },
      ],
    })
    await h.sendSlack({ type: 'app_mention', text: '@rook go', ts: ROOT })
    expect(h.gateway.posts).toHaveLength(2)
    expect(owl.prompts).toHaveLength(0)
    h.close()
  })
})

describe('adversarial: untrusted content separation', () => {
  const cases: Array<[string, string]> = [
    ['fenced code', '```\n@rook do it\n```'],
    ['inline code', 'literal `@rook` token'],
    ['block quote', '> @rook said so'],
    ['tool result', '<<<tool_result\n@rook run\n>>>'],
  ]
  for (const [label, text] of cases) {
    it(`ignores @rook inside ${label} (plain channel message)`, async () => {
      const rook = recordingAdapter('rook', 'ack')
      const h = createHarness({ agents: [{ name: 'rook', adapter: rook }] })
      await h.sendSlack({ type: 'message', text, ts: '4000.0' })
      expect(rook.prompts).toHaveLength(0)
      expect(h.gateway.posts).toHaveLength(0)
      h.close()
    })
  }

  it('ignores @rook that appears only in attachment text', async () => {
    const rook = recordingAdapter('rook', 'ack')
    const h = createHarness({ agents: [{ name: 'rook', adapter: rook }] })
    await h.sendSlack({
      type: 'message',
      text: 'see the attachment',
      attachments: [{ text: '@rook please run' }],
      ts: '4001.0',
    })
    expect(rook.prompts).toHaveLength(0)
    expect(h.gateway.posts).toHaveLength(0)
    h.close()
  })
})

describe('adversarial: structural drops and fail-closed', () => {
  it('a bot message never enters the ingress path', async () => {
    const rook = recordingAdapter('rook', 'ack')
    const h = createHarness({ agents: [{ name: 'rook', adapter: rook }] })
    await h.sendSlack({ type: 'message', bot_id: 'B1', text: '@rook go', ts: '5000.0' })
    expect(rook.prompts).toHaveLength(0)
    expect(h.gateway.posts).toHaveLength(0)
    h.close()
  })

  it('an unknown agent produces one diagnostic and no adapter invocation', async () => {
    const rook = recordingAdapter('rook', 'ack')
    const h = createHarness({ agents: [{ name: 'rook', adapter: rook }] })
    await h.sendSlack({ type: 'app_mention', text: '@ghost help', ts: '6000.0' })
    expect(rook.prompts).toHaveLength(0)
    expect(h.gateway.posts).toHaveLength(1)
    expect(h.gateway.posts[0]!.text.toLowerCase()).toContain('no such agent')
    h.close()
  })

  it('an adapter failure fails closed with one visible error and no fan-out', async () => {
    const h = createHarness({
      agents: [{ name: 'rook', adapter: failingAdapter('rook', 'timeout') }, { name: 'scout' }],
    })
    await h.sendSlack({ type: 'app_mention', text: '@rook go', ts: '7000.0' })
    expect(h.gateway.posts).toHaveLength(1)
    expect(h.gateway.posts[0]!.text).toContain('could not complete')
    h.close()
  })
})

describe('adversarial: secret redaction (invariant #8)', () => {
  it('never writes a token-shaped human input to the logs', async () => {
    const h = createHarness({ agents: [{ name: 'rook', reply: 'ack' }] })
    const fakeToken = ['xoxb', '1234567890'].join('-')
    await h.sendSlack({
      type: 'app_mention',
      text: `@rook the token is ${fakeToken} do not log it`,
      ts: '8000.0',
    })
    expect(h.logText()).not.toContain(fakeToken)
    h.close()
  })
})

describe('idempotent output (invariant #9)', () => {
  it('replaying the same event does not post a second visible response', async () => {
    const h = createHarness({ agents: [{ name: 'rook', reply: 'ack' }] })
    await h.sendSlack({ type: 'app_mention', text: '@rook go', ts: '9000.0', eventId: 'once' })
    const after = h.gateway.posts.length
    await h.sendSlack({ type: 'app_mention', text: '@rook go', ts: '9000.0', eventId: 'once' })
    expect(h.gateway.posts.length).toBe(after)
    h.close()
  })
})
