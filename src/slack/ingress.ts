import type { AdmissionReason, IngressMessage } from '../core/types.js'

/**
 * Raw Slack event shape we care about (a permissive subset of Bolt's payloads).
 * The event id comes from the delivery envelope, passed in by the transport.
 */
export interface RawSlackEvent {
  type: 'message' | 'app_mention'
  subtype?: string
  channel: string
  channel_type?: string
  user?: string
  bot_id?: string
  app_id?: string
  text?: string
  ts: string
  thread_ts?: string
  edited?: unknown
  attachments?: Array<{ text?: string; fallback?: string }>
  files?: Array<{ title?: string; name?: string }>
  metadata?: { event_type?: string; event_payload?: unknown }
}

export interface SlackIngressContext {
  /** Envelope-level unique id for this delivery (Slack `event_id`). */
  eventId: string
  /** Our bot's user id, so we can drop our own echoes. */
  botUserId: string
}

export type NormalizeResult =
  | { ok: true; message: IngressMessage }
  | { ok: false; reason: AdmissionReason; detail: string }

/**
 * Normalize a Slack event into a transport-agnostic {@link IngressMessage},
 * or reject it before it can reach the human ingress path.
 *
 * Rejections here enforce invariant #4's structural half: bot/system subtypes,
 * edited-message echoes, thread-broadcast echoes, and any message carrying our
 * own mesh-output metadata never wake an agent. Agent-to-agent routing does NOT
 * depend on these echoes — the broker enqueues delegates directly.
 */
export function normalizeSlackEvent(evt: RawSlackEvent, ctx: SlackIngressContext): NormalizeResult {
  // Our own output, tagged with mesh metadata → never re-ingress.
  if (typeof evt.metadata?.event_type === 'string' && evt.metadata.event_type.startsWith('mesh')) {
    return { ok: false, reason: 'echo_self_output', detail: 'mesh-tagged output' }
  }
  // Any bot message (ours or another integration) is not a human turn.
  if (evt.bot_id || evt.user === ctx.botUserId) {
    return { ok: false, reason: 'bot_or_system', detail: 'bot or self message' }
  }

  const attachments = collectAttachments(evt)

  if (evt.type === 'app_mention') {
    if (evt.subtype) {
      return { ok: false, reason: 'bot_or_system', detail: `app_mention subtype ${evt.subtype}` }
    }
    return ok('app_mention', evt, ctx, attachments, true)
  }

  // type === 'message'
  if (evt.subtype === 'message_changed') {
    return { ok: false, reason: 'edited_message', detail: 'edited message echo' }
  }
  if (evt.subtype === 'thread_broadcast') {
    return { ok: false, reason: 'thread_broadcast', detail: 'thread broadcast echo' }
  }
  if (evt.subtype) {
    // message_deleted, channel_join, bot_message, etc. — all system noise.
    return { ok: false, reason: 'bot_or_system', detail: `message subtype ${evt.subtype}` }
  }

  if (!evt.user) {
    return { ok: false, reason: 'bot_or_system', detail: 'message without user' }
  }

  if (evt.channel_type === 'im') {
    return ok('direct_message', evt, ctx, attachments, true)
  }
  if (evt.thread_ts && evt.thread_ts !== evt.ts) {
    return ok('thread_reply', evt, ctx, attachments, false)
  }
  // Plain channel message: only a configured-agent mention will admit it.
  return ok('virtual_mention', evt, ctx, attachments, false)
}

function collectAttachments(evt: RawSlackEvent): string[] {
  const out: string[] = []
  for (const a of evt.attachments ?? []) {
    if (a.text) out.push(a.text)
    else if (a.fallback) out.push(a.fallback)
  }
  for (const f of evt.files ?? []) {
    if (f.title) out.push(f.title)
    else if (f.name) out.push(f.name)
  }
  return out
}

function ok(
  kind: IngressMessage['kind'],
  evt: RawSlackEvent,
  ctx: SlackIngressContext,
  attachments: string[],
  explicit: boolean,
): NormalizeResult {
  return {
    ok: true,
    message: {
      eventId: ctx.eventId,
      kind,
      actor: 'human',
      senderId: evt.user ?? 'unknown',
      channel: evt.channel,
      threadTs: evt.thread_ts ?? evt.ts,
      ts: evt.ts,
      text: evt.text ?? '',
      attachments,
      explicitMeshAddress: explicit,
    },
  }
}
