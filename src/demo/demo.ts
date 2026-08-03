import { readFileSync } from 'node:fs'
import { validateConfig } from '../config/load.js'
import type { MeshConfig } from '../config/schema.js'
import { Logger } from '../core/logger.js'
import { createMesh } from '../runtime.js'
import { MockGateway } from '../slack/gateway.js'
import { normalizeSlackEvent, type RawSlackEvent } from '../slack/ingress.js'

interface DemoMessage {
  type?: 'app_mention' | 'direct_message' | 'channel' | 'thread_reply'
  channel: string
  user: string
  text: string
  ts?: string
  thread_ts?: string
}

interface DemoScript {
  title?: string
  config: unknown
  messages: DemoMessage[]
}

export interface DemoResult {
  transcript: string
  lines: string[]
}

function toRawEvent(msg: DemoMessage, index: number): RawSlackEvent {
  const ts = msg.ts ?? `100${index}.000000`
  switch (msg.type ?? 'app_mention') {
    case 'direct_message':
      return {
        type: 'message',
        channel: msg.channel,
        channel_type: 'im',
        user: msg.user,
        text: msg.text,
        ts,
      }
    case 'channel':
      return { type: 'message', channel: msg.channel, user: msg.user, text: msg.text, ts }
    case 'thread_reply':
      return {
        type: 'message',
        channel: msg.channel,
        user: msg.user,
        text: msg.text,
        ts,
        thread_ts: msg.thread_ts ?? ts,
      }
    default:
      return { type: 'app_mention', channel: msg.channel, user: msg.user, text: msg.text, ts }
  }
}

/**
 * Run a fully deterministic, credential-free demo from a script file. Uses mock
 * adapters, an in-memory store, a mock Slack gateway, and injected clock/id
 * generators so the printed transcript and trace receipt are byte-stable.
 */
export async function runDemo(scriptPath: string): Promise<DemoResult> {
  const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as DemoScript
  const config: MeshConfig = validateConfig(script.config)

  // Deterministic generators.
  let traceSeq = 0
  const traceIds: string[] = []
  const newId = () => {
    traceSeq += 1
    const id = `trc_demo_${traceSeq}`
    traceIds.push(id)
    return id
  }
  const fixedNow = () => 1_700_000_000_000
  const gateway = new MockGateway({ botUserId: 'U_MESH_BOT' })

  const mesh = createMesh({
    config,
    gateway,
    logger: new Logger({ level: 'error', sink: () => {} }),
    routerOptions: { now: fixedNow, newId },
  })

  const lines: string[] = []
  lines.push(`=== slack-agent-mesh demo: ${script.title ?? 'conversation'} ===`)
  lines.push('')

  let postCursor = 0
  for (const [i, msg] of script.messages.entries()) {
    const raw = toRawEvent(msg, i)
    const normalized = normalizeSlackEvent(raw, {
      eventId: `demo-${i}`,
      botUserId: gateway.botUserId,
    })
    // Print the human line as it entered the mesh.
    lines.push(`[human ${msg.user}] ${msg.text}`)
    if (!normalized.ok) {
      lines.push(`   ↳ (dropped at ingress: ${normalized.reason})`)
      continue
    }
    await mesh.broker.handleIngress(normalized.message)
    // Print every mesh post produced since the last message.
    for (; postCursor < gateway.posts.length; postCursor++) {
      const post = gateway.posts[postCursor]
      if (post) lines.push(`   ↳ ${post.text}`)
    }
  }

  lines.push('')
  lines.push('--- trace receipts ---')
  for (const traceId of traceIds) {
    const trace = mesh.store.getTrace(traceId)
    if (!trace) continue
    const receipt = {
      trace_id: trace.traceId,
      channel: trace.channel,
      hops: trace.hops,
      messages: trace.messageCount,
      max_hops: config.mesh.max_hops,
      max_messages: config.mesh.max_messages,
      visited: mesh.store.getVisited(traceId),
      status: trace.status,
    }
    lines.push(JSON.stringify(receipt))
  }

  mesh.close()
  const transcript = lines.join('\n')
  return { transcript, lines }
}
