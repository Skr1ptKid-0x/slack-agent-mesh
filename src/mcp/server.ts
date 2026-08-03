import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { InjectAgentTurnResult } from '../broker/broker.js'
import type { Mesh } from '../runtime.js'

const PKG_VERSION = '0.1.0'

/** JSON tool result helper. */
function json(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}

/** Serialize an inject result as the snake_case shape the tool API exposes. */
function injectJson(res: InjectAgentTurnResult) {
  return json({
    ok: res.ok,
    trace_id: res.traceId,
    ts: res.ts,
    channel: res.channel,
    thread_ts: res.threadTs,
    duplicated: res.duplicated,
    reason: res.reason,
  })
}

/**
 * Build the MCP server that exposes mesh messaging, directory, and thread tools
 * to any MCP-capable agent. Every write tool accepts or derives an idempotency
 * key, and every tool returns a structured JSON-compatible object.
 */
export function createMcpServer(mesh: Mesh): McpServer {
  const server = new McpServer({ name: 'slack-agent-mesh', version: PKG_VERSION })

  server.registerTool(
    'mesh_list_agents',
    {
      title: 'List mesh agents',
      description: 'List every configured agent identity, its adapter kind, and presence.',
      inputSchema: {},
    },
    async () =>
      json({
        agents: mesh.config.agents.map((a) => ({
          name: a.name,
          description: a.description,
          adapter: a.adapter.type,
          presence: mesh.gateway.getPresence(a.name) ?? a.presence ?? 'unknown',
        })),
      }),
  )

  server.registerTool(
    'mesh_send',
    {
      title: 'Send a mesh message',
      description:
        'Post a new message to a channel as an agent identity, starting a new trace. ' +
        'Mentions of other configured agents are routed by the broker.',
      inputSchema: {
        agent: z.string().describe('configured agent identity to speak as'),
        channel: z.string().describe('Slack channel id'),
        text: z.string().describe('message body'),
        idempotency_key: z
          .string()
          .optional()
          .describe('optional key; a retry with the same key will not double-post'),
      },
    },
    async (args) => {
      const res = await mesh.broker.injectAgentTurn({
        agent: args.agent,
        channel: args.channel,
        text: args.text,
        idempotencyKey: args.idempotency_key,
      })
      return injectJson(res)
    },
  )

  server.registerTool(
    'mesh_reply',
    {
      title: 'Reply in a mesh thread',
      description:
        'Post a reply into an existing thread as an agent identity. Idempotent on the ' +
        'derived or supplied key.',
      inputSchema: {
        agent: z.string(),
        channel: z.string(),
        thread_ts: z.string().describe('thread root timestamp to reply under'),
        text: z.string(),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => {
      const res = await mesh.broker.injectAgentTurn({
        agent: args.agent,
        channel: args.channel,
        threadTs: args.thread_ts,
        text: args.text,
        idempotencyKey: args.idempotency_key,
      })
      return injectJson(res)
    },
  )

  server.registerTool(
    'mesh_read_thread',
    {
      title: 'Read a mesh thread',
      description: 'Read messages in a thread, including which agent authored each mesh output.',
      inputSchema: {
        channel: z.string(),
        thread_ts: z.string(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async (args) => {
      const messages = await mesh.gateway.readThread({
        channel: args.channel,
        threadTs: args.thread_ts,
        limit: args.limit,
      })
      return json({ channel: args.channel, thread_ts: args.thread_ts, messages })
    },
  )

  server.registerTool(
    'mesh_get_trace',
    {
      title: 'Get a mesh trace',
      description: 'Fetch a trace receipt: hop count, message budget usage, and visited agents.',
      inputSchema: { trace_id: z.string() },
    },
    async (args) => {
      const trace = mesh.store.getTrace(args.trace_id)
      if (!trace) return json({ found: false, trace_id: args.trace_id })
      return json({
        found: true,
        trace: {
          ...trace,
          visited: mesh.store.getVisited(args.trace_id),
          max_hops: mesh.config.mesh.max_hops,
          max_messages: mesh.config.mesh.max_messages,
        },
      })
    },
  )

  server.registerTool(
    'mesh_set_presence',
    {
      title: 'Set agent presence',
      description: 'Set an agent identity presence/status string (idempotent).',
      inputSchema: {
        agent: z.string(),
        presence: z.string(),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => {
      await mesh.gateway.setPresence({ agent: args.agent, presence: args.presence })
      return json({ ok: true, agent: args.agent, presence: args.presence })
    },
  )

  server.registerTool(
    'mesh_add_reaction',
    {
      title: 'Add a reaction',
      description: 'Add an emoji reaction to a message (naturally idempotent).',
      inputSchema: {
        channel: z.string(),
        ts: z.string().describe('timestamp of the message to react to'),
        name: z.string().describe('emoji name without colons'),
        idempotency_key: z.string().optional(),
      },
    },
    async (args) => {
      await mesh.gateway.addReaction({ channel: args.channel, ts: args.ts, name: args.name })
      return json({ ok: true, channel: args.channel, ts: args.ts, name: args.name })
    },
  )

  return server
}

/** Run the MCP server over stdio (the default MCP transport). */
export async function runMcpStdio(mesh: Mesh): Promise<void> {
  const server = createMcpServer(mesh)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
