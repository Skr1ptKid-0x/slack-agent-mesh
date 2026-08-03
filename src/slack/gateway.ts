/**
 * Outbound Slack surface, abstracted so the broker, MCP server, and demo never
 * touch the network directly. The real implementation wraps `@slack/web-api`;
 * the mock implementation records calls in memory for the credential-free demo
 * and the test suite.
 */

export interface PostMessageInput {
  channel: string
  threadTs?: string
  text: string
  /** Marks the message as mesh output so ingress can ignore our own echoes. */
  metadata?: { traceId: string; agent: string }
  /** Reserved for future use; the mesh never broadcasts by default. */
  broadcast?: boolean
}

export interface PostedMessage {
  channel: string
  ts: string
}

export interface ThreadMessage {
  ts: string
  user?: string
  agent?: string
  text: string
  isMesh: boolean
}

export interface SlackGateway {
  readonly botUserId: string
  postMessage(input: PostMessageInput): Promise<PostedMessage>
  updateMessage(input: { channel: string; ts: string; text: string }): Promise<void>
  addReaction(input: { channel: string; ts: string; name: string }): Promise<void>
  /** Best-effort presence/status surface. Virtual agents have no native Slack
   * presence, so this records intent (and is surfaced by directory tools). */
  setPresence(input: { agent: string; presence: string }): Promise<void>
  getPresence(agent: string): string | undefined
  readThread(input: { channel: string; threadTs: string; limit?: number }): Promise<ThreadMessage[]>
}

/** In-memory gateway used by the demo, MCP-without-Slack, and tests. */
export class MockGateway implements SlackGateway {
  readonly botUserId: string
  private seq = 0
  readonly posts: Array<PostMessageInput & { ts: string }> = []
  readonly reactions: Array<{ channel: string; ts: string; name: string }> = []
  private readonly presence = new Map<string, string>()
  /** Injectable ts generator keeps demo/test output deterministic. */
  private readonly mint: () => string

  constructor(opts: { botUserId?: string; mintTs?: () => string } = {}) {
    this.botUserId = opts.botUserId ?? 'U_MESH_BOT'
    this.mint = opts.mintTs ?? (() => `${1000 + this.seq}.${String(this.seq).padStart(6, '0')}`)
  }

  async postMessage(input: PostMessageInput): Promise<PostedMessage> {
    this.seq += 1
    const ts = this.mint()
    this.posts.push({ ...input, ts })
    return { channel: input.channel, ts }
  }

  async updateMessage(input: { channel: string; ts: string; text: string }): Promise<void> {
    const post = this.posts.find((p) => p.channel === input.channel && p.ts === input.ts)
    if (post) post.text = input.text
  }

  async addReaction(input: { channel: string; ts: string; name: string }): Promise<void> {
    this.reactions.push(input)
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
    const msgs = this.posts
      .filter((p) => p.channel === input.channel && (p.threadTs ?? p.ts) === input.threadTs)
      .map<ThreadMessage>((p) => ({
        ts: p.ts,
        agent: p.metadata?.agent,
        text: p.text,
        isMesh: true,
      }))
    return input.limit ? msgs.slice(-input.limit) : msgs
  }
}
