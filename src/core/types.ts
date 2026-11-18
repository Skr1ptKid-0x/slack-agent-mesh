/**
 * Shared domain types for the mesh. Nothing here imports a Slack or model-provider
 * SDK: the router and trace logic operate on plain data so they can be unit tested
 * and reused by any transport.
 */

/** Source of a human/agent turn that arrives at the broker. */
export type IngressKind =
  | 'app_mention'
  | 'slash_command'
  | 'direct_message'
  | 'thread_reply'
  | 'virtual_mention'
  | 'agent_delegation'
  | 'mcp_send'

/** The origin actor of a message. */
export type ActorKind = 'human' | 'agent' | 'system'

/**
 * A normalized inbound message. Slack, MCP, and the demo all convert their
 * native payloads into this shape before the router sees them.
 */
export interface IngressMessage {
  /** Stable per-delivery identifier used for dedupe (Slack event_id, or a synthetic id). */
  eventId: string
  kind: IngressKind
  actor: ActorKind
  /** Free-form id of the sender (Slack user id, agent name, or "system"). */
  senderId: string
  /** Logical channel/conversation id. */
  channel: string
  /** Thread root timestamp/id. Channel-root turns use the triggering message ts. */
  threadTs: string
  /** Timestamp/id of this specific message. */
  ts: string
  /** The human-authored or agent-authored text body. */
  text: string
  /**
   * Untrusted side content that must never be scanned for delegating mentions:
   * Slack attachment text, quoted-message blocks, file previews, etc.
   */
  attachments?: string[]
  /** When present, the mesh app was explicitly addressed (real app mention or slash/DM). */
  explicitMeshAddress?: boolean
  /**
   * For agent_delegation turns: the trace this delegation belongs to. Human turns
   * omit this and the broker starts (or resumes by thread) a trace.
   */
  traceId?: string
  /** For agent_delegation: which agent authored the delegating message. */
  fromAgent?: string
  /** For virtual_mention/agent turns: agents explicitly named by name in trusted text. */
  targetAgent?: string
}

/** Result of the router deciding whether and how to admit a message. */
export interface AdmissionDecision {
  admit: boolean
  /** Machine-readable reason, always set (even on admit, e.g. "app_mention"). */
  reason: AdmissionReason
  /** Resolved trace id when admitted. */
  traceId?: string
  /** Agents that should be invoked for this turn (already validated). */
  targets?: string[]
  /** Human-readable note for diagnostics/logs. */
  detail?: string
}

export type AdmissionReason =
  | 'app_mention'
  | 'slash_command'
  | 'direct_message'
  | 'thread_reply'
  | 'virtual_mention'
  | 'agent_delegation'
  | 'mcp_send'
  | 'duplicate_event'
  | 'not_addressed'
  | 'not_allowed'
  | 'bot_or_system'
  | 'echo_self_output'
  | 'edited_message'
  | 'thread_broadcast'
  | 'unknown_agent'
  | 'self_mention'
  | 'already_visited'
  | 'hop_limit'
  | 'message_budget'
  | 'trace_expired'
  | 'no_target'

/** A unit of work: invoke one agent inside a trace and deliver its output. */
export interface TurnRequest {
  traceId: string
  agent: string
  prompt: string
  channel: string
  threadTs: string
  /** The ingress that caused this turn (for logging/receipts). */
  causeEventId: string
  /** hop index of this turn (0 for the first human-triggered turn). */
  hop: number
}

/** Persisted trace snapshot. */
export interface TraceRecord {
  traceId: string
  channel: string
  rootTs: string
  hops: number
  messageCount: number
  createdAt: number
  updatedAt: number
  status: 'active' | 'closed'
}

export interface OutputReceipt {
  outputKey: string
  traceId: string
  channel: string
  ts: string
  createdAt: number
}
