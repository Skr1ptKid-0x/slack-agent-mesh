import type { MeshConfig } from '../config/schema.js'
import type { Store } from '../store/store.js'
import { delegationKey, newTraceId } from './ids.js'
import type { Logger } from './logger.js'
import { extractMentions, extractMentionTokens } from './mentions.js'
import type { AdmissionDecision, AdmissionReason, IngressMessage, TurnRequest } from './types.js'

export interface RouterOptions {
  /** Injectable clock for tests (ms since epoch). */
  now?: () => number
  /** Injectable trace-id generator for deterministic tests/demo. */
  newId?: () => string
}

export interface HumanAdmission extends AdmissionDecision {
  /** Raw `@tokens` that named no configured agent (drives the unknown diagnostic). */
  unknownMentions: string[]
}

export interface DelegationEdge {
  traceId: string
  fromAgent: string
  toAgent: string
  causeEventId: string
  /** hop index of the *source* turn; the delegate runs at sourceHop + 1. */
  sourceHop: number
}

export interface DelegationAdmission {
  admit: boolean
  reason: AdmissionReason
  traceId: string
  target?: string
  hop?: number
  detail?: string
}

export interface ReserveResult {
  ok: boolean
  reason: AdmissionReason
}

/**
 * The router is the single authority on *whether* a message may wake an agent
 * and *which* agents run. It is transport-agnostic and side-effect-minimal:
 * the only mutations are dedupe/trace bookkeeping in the {@link Store}. All
 * loop-prevention invariants (dedupe, hop limit, message budget, visited set,
 * self-mention, expiry) live here so every transport inherits them.
 */
export class Router {
  private readonly now: () => number
  private readonly newId: () => string
  private readonly knownAgents: string[]

  constructor(
    private readonly config: MeshConfig,
    private readonly store: Store,
    private readonly log: Logger,
    opts: RouterOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now())
    this.newId = opts.newId ?? newTraceId
    this.knownAgents = config.agents.map((a) => a.name)
  }

  private isKnown(name: string): boolean {
    const lc = name.toLowerCase()
    return this.knownAgents.some((n) => n.toLowerCase() === lc)
  }

  private canonical(name: string): string | undefined {
    const lc = name.toLowerCase()
    return this.knownAgents.find((n) => n.toLowerCase() === lc)
  }

  /**
   * Decide admission for a normalized human/ingress message. Records the event
   * for dedupe, resolves targets, and creates a fresh trace on admit. Each human
   * turn starts a NEW trace (fresh hop/visited/budget) threaded into the same
   * Slack thread, so a legitimate follow-up is never blocked by the visited set.
   */
  admit(msg: IngressMessage): HumanAdmission {
    // 1. Dedupe: a replayed event id must never produce a second turn.
    if (!this.store.recordEvent(msg.eventId)) {
      return this.reject('duplicate_event', 'duplicate event id')
    }

    // 1b. Allowlists: a sender or channel outside them never wakes an agent and
    // gets no diagnostic, so the mesh does not reveal itself to them. An empty
    // list fails closed unless the matching allow_any_* flag opts in.
    const { allowed_users, allowed_channels, allow_any_user, allow_any_channel } = this.config.mesh
    if (allowed_users.length === 0 ? !allow_any_user : !allowed_users.includes(msg.senderId)) {
      return this.reject('not_allowed', 'sender not in allowed_users')
    }
    if (
      allowed_channels.length === 0 ? !allow_any_channel : !allowed_channels.includes(msg.channel)
    ) {
      return this.reject('not_allowed', 'channel not in allowed_channels')
    }

    // 2. Resolve targets by ingress kind.
    const knownTokens = extractMentions(msg.text, this.knownAgents).mentions
    const allTokens = extractMentionTokens(msg.text)
    const unknown = allTokens.filter((t) => !this.isKnown(t))

    let targets: string[] = []
    let reason: AdmissionReason

    switch (msg.kind) {
      case 'app_mention':
      case 'slash_command': {
        reason = msg.kind
        targets = knownTokens
        // Explicitly addressed to the mesh but naming no known agent.
        if (targets.length === 0) {
          const r: AdmissionReason = unknown.length > 0 ? 'unknown_agent' : 'no_target'
          return { admit: false, reason: r, unknownMentions: unknown }
        }
        break
      }
      case 'direct_message': {
        reason = 'direct_message'
        targets = knownTokens
        if (targets.length === 0) {
          const r: AdmissionReason = unknown.length > 0 ? 'unknown_agent' : 'no_target'
          return { admit: false, reason: r, unknownMentions: unknown }
        }
        break
      }
      case 'thread_reply': {
        // Only follow-ups inside a thread the mesh already owns are admitted.
        const thread = this.store.getThread(msg.channel, msg.threadTs)
        if (!thread) {
          return this.reject('not_addressed', 'reply in a thread the mesh does not own')
        }
        reason = 'thread_reply'
        targets = knownTokens.length > 0 ? knownTokens : [thread.primaryAgent]
        break
      }
      case 'virtual_mention': {
        // Plain channel chatter: admit ONLY when a configured agent is named in
        // trusted text. Unknown "@foo" noise is ignored, not diagnosed, so the
        // mesh never chatters back at ordinary channel traffic.
        reason = 'virtual_mention'
        targets = knownTokens
        if (targets.length === 0) {
          return this.reject('not_addressed', 'no configured agent mentioned')
        }
        break
      }
      default:
        return this.reject('not_addressed', `unsupported ingress kind ${msg.kind}`)
    }

    // 3. Canonicalize + guard against an empty target list.
    const canonicalTargets = targets.map((t) => this.canonical(t)).filter((t): t is string => !!t)
    if (canonicalTargets.length === 0) {
      return { admit: false, reason: 'no_target', unknownMentions: unknown }
    }

    // 4. Create the fresh trace for this human turn.
    const traceId = this.newId()
    const now = this.now()
    this.store.createTrace({
      traceId,
      channel: msg.channel,
      rootTs: msg.threadTs,
      hops: 0,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      status: 'active',
    })

    return {
      admit: true,
      reason,
      traceId,
      targets: canonicalTargets,
      unknownMentions: unknown,
    }
  }

  /**
   * Decide whether an agent's emitted mention of another agent may delegate.
   * Rejects self-mentions, unknown agents, revisits, hop-limit and budget
   * overruns, expired traces, and duplicate delegation edges — all before any
   * adapter is touched.
   */
  admitDelegation(edge: DelegationEdge): DelegationAdmission {
    const { traceId, fromAgent, toAgent, causeEventId } = edge

    if (!this.isKnown(toAgent)) {
      return { admit: false, reason: 'unknown_agent', traceId, detail: `unknown agent ${toAgent}` }
    }
    const target = this.canonical(toAgent) as string

    if (target.toLowerCase() === fromAgent.toLowerCase()) {
      return { admit: false, reason: 'self_mention', traceId, detail: 'agent mentioned itself' }
    }

    const trace = this.store.getTrace(traceId)
    if (trace?.status !== 'active') {
      return { admit: false, reason: 'trace_expired', traceId, detail: 'no active trace' }
    }
    if (this.now() - trace.createdAt > this.config.mesh.trace_ttl_seconds * 1000) {
      return { admit: false, reason: 'trace_expired', traceId, detail: 'trace ttl exceeded' }
    }

    const nextHop = edge.sourceHop + 1
    if (nextHop > this.config.mesh.max_hops) {
      return { admit: false, reason: 'hop_limit', traceId, detail: `hop ${nextHop} > max` }
    }
    if (trace.messageCount + 1 > this.config.mesh.max_messages) {
      return { admit: false, reason: 'message_budget', traceId, detail: 'message budget exceeded' }
    }
    if (this.store.hasVisited(traceId, target)) {
      return { admit: false, reason: 'already_visited', traceId, detail: `${target} already ran` }
    }

    // Collapse duplicate identical delegation edges (e.g. retry of the source).
    if (
      !this.store.recordDelegation(
        delegationKey({ traceId, fromAgent, toAgent: target, causeEventId }),
      )
    ) {
      return { admit: false, reason: 'duplicate_event', traceId, detail: 'duplicate delegation' }
    }

    return { admit: true, reason: 'agent_delegation', traceId, target, hop: nextHop }
  }

  /**
   * Final atomic guard executed immediately before an adapter runs. Reserves the
   * turn by marking the agent visited and consuming hop/budget. Returns ok=false
   * (without mutating) if the turn would violate an invariant — defense-in-depth
   * behind {@link admit} / {@link admitDelegation}.
   */
  reserveTurn(turn: TurnRequest): ReserveResult {
    const trace = this.store.getTrace(turn.traceId)
    if (trace?.status !== 'active') return { ok: false, reason: 'trace_expired' }
    if (this.now() - trace.createdAt > this.config.mesh.trace_ttl_seconds * 1000) {
      return { ok: false, reason: 'trace_expired' }
    }
    if (turn.hop > this.config.mesh.max_hops) return { ok: false, reason: 'hop_limit' }
    if (trace.messageCount + 1 > this.config.mesh.max_messages) {
      return { ok: false, reason: 'message_budget' }
    }
    if (!this.store.addVisited(turn.traceId, turn.agent)) {
      return { ok: false, reason: 'already_visited' }
    }
    this.store.updateTrace({
      ...trace,
      messageCount: trace.messageCount + 1,
      hops: Math.max(trace.hops, turn.hop),
      updatedAt: this.now(),
    })
    return { ok: true, reason: turn.hop === 0 ? 'app_mention' : 'agent_delegation' }
  }

  private reject(reason: AdmissionReason, detail: string): HumanAdmission {
    this.log.logDebug('ingress rejected', { reason, detail })
    return { admit: false, reason, unknownMentions: [] }
  }
}
