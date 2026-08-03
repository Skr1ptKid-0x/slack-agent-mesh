import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMcpServer } from '../../src/mcp/server.js'
import { createHarness, type Harness } from '../helpers/harness.js'

let h: Harness
let client: Client

async function connect() {
  const server = createMcpServer(h.mesh)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test', version: '0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
}

function parse(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content
  return JSON.parse(content[0]!.text)
}

beforeEach(async () => {
  h = createHarness({
    agents: [
      { name: 'rook', description: 'commander', reply: 'ack' },
      { name: 'scout', reply: 'ok' },
    ],
  })
  await connect()
})

afterEach(() => h.close())

describe('MCP tool surface', () => {
  it('exposes every required tool', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        'mesh_add_reaction',
        'mesh_get_trace',
        'mesh_list_agents',
        'mesh_read_thread',
        'mesh_reply',
        'mesh_send',
        'mesh_set_presence',
      ].sort(),
    )
  })

  it('mesh_list_agents returns the directory', async () => {
    const res = parse(await client.callTool({ name: 'mesh_list_agents', arguments: {} }))
    const agents = res.agents as Array<{ name: string }>
    expect(agents.map((a) => a.name)).toEqual(['rook', 'scout'])
  })

  it('mesh_send posts a visible message with trace metadata', async () => {
    const res = parse(
      await client.callTool({
        name: 'mesh_send',
        arguments: { agent: 'rook', channel: 'C1', text: 'hello mesh' },
      }),
    )
    expect(res.ok).toBe(true)
    expect(typeof res.ts).toBe('string')
    const post = h.gateway.posts.at(-1)
    expect(post?.metadata).toMatchObject({ agent: 'rook', traceId: res.trace_id as string })
  })

  it('mesh_send is idempotent on the idempotency key', async () => {
    const args = { agent: 'rook', channel: 'C1', text: 'once', idempotency_key: 'k-1' }
    const first = parse(await client.callTool({ name: 'mesh_send', arguments: args }))
    const countAfterFirst = h.gateway.posts.length
    const second = parse(await client.callTool({ name: 'mesh_send', arguments: args }))
    expect(second.duplicated).toBe(true)
    expect(second.ts).toBe(first.ts)
    expect(h.gateway.posts.length).toBe(countAfterFirst)
  })

  it('mesh_get_trace returns a receipt with visited agents', async () => {
    const sent = parse(
      await client.callTool({
        name: 'mesh_send',
        arguments: { agent: 'rook', channel: 'C1', text: 'delegate to @scout please' },
      }),
    )
    const trace = parse(
      await client.callTool({ name: 'mesh_get_trace', arguments: { trace_id: sent.trace_id } }),
    )
    expect(trace.found).toBe(true)
    const t = trace.trace as { visited: string[] }
    expect(t.visited).toContain('rook')
    expect(t.visited).toContain('scout')
  })

  it('mesh_read_thread reads posted messages', async () => {
    const sent = parse(
      await client.callTool({
        name: 'mesh_send',
        arguments: { agent: 'rook', channel: 'C1', text: 'hi' },
      }),
    )
    const read = parse(
      await client.callTool({
        name: 'mesh_read_thread',
        arguments: { channel: 'C1', thread_ts: sent.thread_ts },
      }),
    )
    const messages = read.messages as Array<{ agent?: string }>
    expect(messages.some((m) => m.agent === 'rook')).toBe(true)
  })
})
