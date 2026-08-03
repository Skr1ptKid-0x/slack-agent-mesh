import { WebClient } from '@slack/web-api'
import type { Logger } from '../core/logger.js'
import type { PostedMessage, PostMessageInput, SlackGateway, ThreadMessage } from './gateway.js'

/**
 * Real outbound Slack surface backed by `@slack/web-api`. Virtual agent
 * identities are rendered with per-message `username`/`icon_emoji` overrides
 * (requires the `chat:write.customize` scope), so one Slack app can speak as
 * `@rook`, `@scout`, etc. Presence is tracked locally because Slack has no
 * native presence for virtual identities (see README limitations).
 */
export class WebApiGateway implements SlackGateway {
  readonly botUserId: string
  private readonly client: WebClient
  private readonly presence = new Map<string, string>()
  private readonly log: Logger

  constructor(opts: { token: string; botUserId: string; logger: Logger; client?: WebClient }) {
    this.client = opts.client ?? new WebClient(opts.token)
    this.botUserId = opts.botUserId
    this.log = opts.logger
  }

  async postMessage(input: PostMessageInput): Promise<PostedMessage> {
    const res = await this.client.chat.postMessage({
      channel: input.channel,
      text: input.text,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      ...(input.metadata
        ? {
            username: input.metadata.agent,
            icon_emoji: ':robot_face:',
            metadata: {
              event_type: 'mesh_output',
              event_payload: {
                trace_id: input.metadata.traceId,
                agent: input.metadata.agent,
              },
            },
          }
        : {}),
    })
    if (!res.ok || !res.ts) {
      throw new Error(`chat.postMessage failed: ${res.error ?? 'unknown error'}`)
    }
    return { channel: input.channel, ts: res.ts }
  }

  async updateMessage(input: { channel: string; ts: string; text: string }): Promise<void> {
    await this.client.chat.update({ channel: input.channel, ts: input.ts, text: input.text })
  }

  async addReaction(input: { channel: string; ts: string; name: string }): Promise<void> {
    try {
      await this.client.reactions.add({
        channel: input.channel,
        timestamp: input.ts,
        name: input.name,
      })
    } catch (err) {
      const slackError = (err as { data?: { error?: string } }).data?.error
      if (slackError === 'already_reacted') return
      this.log.warn('addReaction failed', { error: (err as Error).message, slackError })
      throw err
    }
  }

  async setPresence(input: { agent: string; presence: string }): Promise<void> {
    this.presence.set(input.agent, input.presence)
  }

  getPresence(agent: string): string | undefined {
    return this.presence.get(agent)
  }

  async readThread(input: {
    channel: string
    threadTs: string
    limit?: number
  }): Promise<ThreadMessage[]> {
    const res = await this.client.conversations.replies({
      channel: input.channel,
      ts: input.threadTs,
      limit: input.limit ?? 100,
    })
    const messages = res.messages ?? []
    return messages.map((m) => {
      const payload = m.metadata?.event_payload as { agent?: string } | undefined
      return {
        ts: (m.ts as string) ?? '',
        user: m.user as string | undefined,
        agent: payload?.agent,
        text: (m.text as string) ?? '',
        isMesh: m.metadata?.event_type === 'mesh_output',
      }
    })
  }
}
