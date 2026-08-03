import { describe, expect, it } from 'vitest'
import { SLACK_MAX_TEXT } from '../../src/core/text.js'
import {
  createHarness,
  FlakyGateway,
  failingAdapter,
  recordingAdapter,
} from '../helpers/harness.js'

const CHANNEL = 'C_TEST'
const ROOT = '1000.000000'

/**
 * These scenarios pin down the exactly-one-visible-post guarantees around the
 * MCP inject path and the anchorless multi-target routing that the broker-level
 * suite did not yet exercise directly. They also confirm the reliability *bound*
 * we actually promise: concurrent same-key retries are suppressed, a rejected
 * post frees the claim for a later retry, and a mention hidden past Slack's 40k
 * cap can never route.
 */
describe('reliability: concurrent injectAgentTurn with the same key', () => {
  it('two simultaneous same-key injects post exactly once; the loser does not', async () => {
    const h = createHarness({ agents: [{ name: 'rook' }] })
    const input = {
      agent: 'rook',
      channel: CHANNEL,
      text: 'concurrent hello',
      idempotencyKey: 'idem-concurrent-1',
    }

    // Start both before awaiting either: the first runs its synchronous prefix —
    // including the PRIMARY-KEY-guarded claim — to completion and only yields at
    // the (async) Slack post, so the second observes the pending claim and the
    // race resolves deterministically to one winner and one suppressed loser.
    const results = await Promise.all([
      h.mesh.broker.injectAgentTurn(input),
      h.mesh.broker.injectAgentTurn(input),
    ])

    // Exactly one visible Slack post, no matter how the two calls interleaved.
    expect(h.gateway.posts).toHaveLength(1)

    const winners = results.filter((r) => r.ok && !r.duplicated)
    const losers = results.filter((r) => r.duplicated)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    const winner = winners[0]!
    const loser = losers[0]!
    expect(winner.ts).toBeDefined()
    expect(winner.ts).toBe(h.gateway.posts[0]!.ts)

    // The loser is either still mid-post (honest output_pending, no phantom
    // receipt) or — had the winner finalized first — a duplicate echoing the
    // winner's ts. Never a second post, never a fabricated ts.
    if (!loser.ok) {
      expect(loser.reason).toBe('output_pending')
      expect(loser.ts).toBeUndefined()
    } else {
      expect(loser.ts).toBe(winner.ts)
    }
    h.close()
  })

  it('a rejected Slack post releases the pending claim so a same-key retry succeeds', async () => {
    // The gateway throws on the first post (after the claim is taken) and
    // succeeds thereafter.
    const gateway = new FlakyGateway(1)
    const h = createHarness({ agents: [{ name: 'rook' }], gateway })
    const input = {
      agent: 'rook',
      channel: CHANNEL,
      text: 'retry me',
      idempotencyKey: 'idem-retry-1',
    }

    await expect(h.mesh.broker.injectAgentTurn(input)).rejects.toThrow()
    // The failed post recorded nothing visible.
    expect(h.gateway.posts).toHaveLength(0)

    // The retry must take a FRESH claim (duplicated:false). If the first attempt
    // had wedged a pending claim, this would instead come back ok:false /
    // output_pending — so ok:true here is the proof the claim was released.
    const retry = await h.mesh.broker.injectAgentTurn(input)
    expect(retry.ok).toBe(true)
    expect(retry.duplicated).toBe(false)
    expect(retry.ts).toBeDefined()
    expect(h.gateway.posts).toHaveLength(1)
    h.close()
  })

  it('a duplicate completed top-level inject returns the original posted ts as threadTs', async () => {
    const h = createHarness({ agents: [{ name: 'rook' }] })
    const input = {
      agent: 'rook',
      channel: CHANNEL,
      text: 'top-level post',
      idempotencyKey: 'idem-top-1',
    }

    const first = await h.mesh.broker.injectAgentTurn(input)
    expect(first.ok).toBe(true)
    expect(first.duplicated).toBe(false)
    // A top-level post has no caller-supplied anchor: its own ts becomes the
    // thread root that follow-ups reply under.
    expect(first.threadTs).toBe(first.ts)
    expect(h.mesh.store.getTrace(first.traceId)?.rootTs).toBe(first.ts)

    const dup = await h.mesh.broker.injectAgentTurn(input)
    expect(dup.duplicated).toBe(true)
    expect(dup.ts).toBe(first.ts)
    // The duplicate must echo the ORIGINAL posted ts as the thread anchor — not
    // the absent input.threadTs — or the caller loses the thread to follow up in.
    expect(dup.threadTs).toBe(first.ts)
    // Still exactly one visible post.
    expect(h.gateway.posts).toHaveLength(1)
    h.close()
  })
})

describe('reliability: anchorless multi-target slash trace root binding', () => {
  it('a failing first target still creates the root; the second target replies under it', async () => {
    const h = createHarness({
      agents: [
        { name: 'rook', adapter: failingAdapter('rook', 'timeout') },
        { name: 'scout', reply: 'scout on it' },
      ],
    })

    // A slash command has no thread anchor: the trace root is bound by the first
    // visible post, which here is @rook's fail-closed diagnostic.
    await h.sendIngress({
      eventId: 'slash-fail-first',
      kind: 'slash_command',
      actor: 'human',
      senderId: 'U1',
      channel: CHANNEL,
      threadTs: '',
      ts: '',
      text: '@rook @scout investigate',
      explicitMeshAddress: true,
    })

    expect(h.gateway.posts).toHaveLength(2)
    const [first, second] = h.gateway.posts
    // First post is the fail-closed diagnostic, top-level (it becomes the root).
    expect(first!.text).toContain('could not complete')
    expect(first!.threadTs).toBeUndefined()
    // The successful second target threads UNDER that root rather than spawning a
    // parallel top-level message.
    expect(second!.text).toContain('scout on it')
    expect(second!.threadTs).toBe(first!.ts)
    h.close()
  })

  it('a fully successful slash trace creates one root; the second output threads under it', async () => {
    const h = createHarness({
      agents: [
        { name: 'rook', reply: 'rook ack' },
        { name: 'scout', reply: 'scout ack' },
      ],
    })

    await h.sendIngress({
      eventId: 'slash-both-ok',
      kind: 'slash_command',
      actor: 'human',
      senderId: 'U1',
      channel: CHANNEL,
      threadTs: '',
      ts: '',
      text: '@rook @scout status',
      explicitMeshAddress: true,
    })

    expect(h.gateway.posts).toHaveLength(2)
    const [first, second] = h.gateway.posts
    // Exactly one top-level root...
    expect(first!.threadTs).toBeUndefined()
    // ...and the second output is threaded beneath it.
    expect(second!.threadTs).toBe(first!.ts)
    // Both share the single trace.
    const traceId = first!.metadata!.traceId
    expect(second!.metadata!.traceId).toBe(traceId)
    expect(h.mesh.store.getVisited(traceId)).toEqual(['rook', 'scout'])
    h.close()
  })
})

describe('reliability: a mention past the 40k Slack cap never routes', () => {
  it('@scout only beyond the formatted limit never invokes Scout; posted text stays <= 40000', async () => {
    const scout = recordingAdapter('scout', 'scout ran')
    // The ONLY @scout token sits well past the 40k cap, so it survives in neither
    // the visible Slack text nor the bounded body the broker scans for mentions.
    const longReply = `${'x'.repeat(SLACK_MAX_TEXT + 500)} @scout urgent`
    const h = createHarness({
      agents: [
        { name: 'rook', reply: longReply },
        { name: 'scout', adapter: scout },
      ],
    })

    await h.sendSlack({ type: 'app_mention', text: '@rook go long', ts: ROOT })

    // Scout was never invoked...
    expect(scout.prompts).toHaveLength(0)
    // ...only @rook posted...
    expect(h.gateway.posts).toHaveLength(1)
    // ...and the payload Slack would receive is within its practical cap.
    expect(h.gateway.posts[0]!.text.length).toBeLessThanOrEqual(SLACK_MAX_TEXT)
    h.close()
  })

  it('control: the same @scout token within the cap DOES route (proves it is a real mention)', async () => {
    const scout = recordingAdapter('scout', 'scout ran')
    const h = createHarness({
      agents: [
        { name: 'rook', reply: 'please loop in @scout urgent' },
        { name: 'scout', adapter: scout },
      ],
    })

    await h.sendSlack({ type: 'app_mention', text: '@rook go', ts: ROOT })

    expect(scout.prompts).toHaveLength(1)
    expect(h.gateway.posts).toHaveLength(2)
    h.close()
  })
})
