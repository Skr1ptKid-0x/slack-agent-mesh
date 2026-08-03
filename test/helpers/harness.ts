import type { Adapter, AdapterErrorKind } from '../../src/adapters/types.js'
import { validateConfig } from '../../src/config/load.js'
import { Logger } from '../../src/core/logger.js'
import type { IngressMessage } from '../../src/core/types.js'
import { createMesh, type Mesh } from '../../src/runtime.js'
import { MockGateway, type PostedMessage, type PostMessageInput } from '../../src/slack/gateway.js'
import { normalizeSlackEvent, type RawSlackEvent } from '../../src/slack/ingress.js'

export interface HarnessAgent {
  name: string
  description?: string
  /** Default mock reply. */
  reply?: string
  /** Ordered mock rules. */
  replies?: Array<{ when_prompt_contains?: string; reply: string }>
  /** Fully override this agent's adapter (for failure-mode tests). */
  adapter?: Adapter
}

export interface HarnessOptions {
  agents: HarnessAgent[]
  maxHops?: number
  maxMessages?: number
  ttlSeconds?: number
  now?: () => number
  /** Override the mock gateway (e.g. a flaky one that throws on postMessage). */
  gateway?: MockGateway
}

export interface Harness {
  mesh: Mesh
  gateway: MockGateway
  logs: string[]
  logText(): string
  /** Post texts in order (mesh outputs and diagnostics). */
  postTexts(): string[]
  /** Feed a raw Slack event through the real ingress + broker path. */
  sendSlack(evt: Partial<RawSlackEvent> & { eventId?: string }): Promise<void>
  /** Feed an already-normalized ingress message directly. */
  sendIngress(msg: IngressMessage): Promise<void>
  close(): void
}

let traceCounter = 0

/**
 * Build a fully in-memory mesh with mock adapters, a mock gateway, and captured
 * logs. Deterministic trace ids make assertions stable across runs.
 */
export function createHarness(opts: HarnessOptions): Harness {
  const logs: string[] = []
  const logger = new Logger({ level: 'debug', debug: false, sink: (l) => logs.push(l) })

  const configObject = {
    mesh: {
      max_hops: opts.maxHops ?? 4,
      max_messages: opts.maxMessages ?? 12,
      trace_ttl_seconds: opts.ttlSeconds ?? 3600,
      state_path: ':memory:',
    },
    agents: opts.agents.map((a) => ({
      name: a.name,
      description: a.description ?? '',
      adapter: {
        type: 'mock' as const,
        reply: a.reply ?? '',
        replies: a.replies ?? [],
      },
    })),
  }
  const config = validateConfig(configObject)

  const gateway = opts.gateway ?? new MockGateway({ botUserId: 'U_MESH_BOT' })
  const newId = () => {
    traceCounter += 1
    return `trc_test_${traceCounter}`
  }

  const mesh = createMesh({
    config,
    gateway,
    logger,
    routerOptions: { newId, now: opts.now },
  })

  // Apply any adapter overrides for failure-mode testing.
  for (const a of opts.agents) {
    if (a.adapter) mesh.adapters.set(a.name, a.adapter)
  }

  return {
    mesh,
    gateway,
    logs,
    logText: () => logs.join('\n'),
    postTexts: () => gateway.posts.map((p) => p.text),
    async sendSlack(evt) {
      const raw: RawSlackEvent = {
        type: evt.type ?? 'app_mention',
        channel: evt.channel ?? 'C_TEST',
        user: evt.user ?? 'U_HUMAN',
        text: evt.text ?? '',
        ts: evt.ts ?? '1000.000000',
        ...evt,
      }
      const eventId = evt.eventId ?? `evt-${raw.channel}-${raw.ts}`
      const result = normalizeSlackEvent(raw, { eventId, botUserId: gateway.botUserId })
      if (result.ok) await mesh.broker.handleIngress(result.message)
    },
    async sendIngress(msg) {
      await mesh.broker.handleIngress(msg)
    },
    close: () => mesh.close(),
  }
}

/** A test-double adapter that always fails closed with a given kind. */
export function failingAdapter(name: string, kind: AdapterErrorKind): Adapter {
  return {
    name,
    kind: 'command',
    async invoke() {
      return { ok: false, kind, error: `simulated ${kind}` }
    },
  }
}

/** A test-double adapter that records prompts and returns a fixed reply. */
export function recordingAdapter(name: string, reply: string): Adapter & { prompts: string[] } {
  const prompts: string[] = []
  return {
    name,
    kind: 'command',
    prompts,
    async invoke(req) {
      prompts.push(req.prompt)
      return { ok: true, text: reply }
    },
  }
}

/**
 * A {@link MockGateway} that rejects its first `failures` `postMessage` calls —
 * throwing *before* it records anything — then behaves normally. This drives the
 * reliability path where Slack rejects a post *after* the broker has taken the
 * pending output claim: the broker must release that claim so a same-key retry
 * can succeed rather than wedging the key forever.
 */
export class FlakyGateway extends MockGateway {
  private failuresRemaining: number

  constructor(failures: number, opts: { botUserId?: string } = {}) {
    super({ botUserId: opts.botUserId ?? 'U_MESH_BOT' })
    this.failuresRemaining = failures
  }

  override async postMessage(input: PostMessageInput): Promise<PostedMessage> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error('simulated Slack post rejection')
    }
    return super.postMessage(input)
  }
}
