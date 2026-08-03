import type { WebClient } from '@slack/web-api'
import { describe, expect, it, vi } from 'vitest'
import { Logger } from '../../src/core/logger.js'
import { WebApiGateway } from '../../src/slack/web-gateway.js'

function gatewayWith(add: ReturnType<typeof vi.fn>) {
  const client = { reactions: { add } } as unknown as WebClient
  return new WebApiGateway({
    token: 'unused',
    botUserId: 'U_MESH',
    logger: new Logger({ sink: () => undefined }),
    client,
  })
}

describe('WebApiGateway reactions', () => {
  it('treats already_reacted as idempotent success', async () => {
    const error = Object.assign(new Error('already reacted'), {
      data: { error: 'already_reacted' },
    })
    const gateway = gatewayWith(vi.fn().mockRejectedValue(error))

    await expect(
      gateway.addReaction({ channel: 'C1', ts: '1.000', name: 'white_check_mark' }),
    ).resolves.toBeUndefined()
  })

  it('surfaces real Slack failures to the MCP caller', async () => {
    const error = Object.assign(new Error('channel missing'), {
      data: { error: 'channel_not_found' },
    })
    const gateway = gatewayWith(vi.fn().mockRejectedValue(error))

    await expect(
      gateway.addReaction({ channel: 'C404', ts: '1.000', name: 'eyes' }),
    ).rejects.toThrow('channel missing')
  })
})

describe('WebApiGateway thread reads', () => {
  it('requests and preserves Slack message metadata', async () => {
    const replies = vi.fn(async () => ({
      ok: true,
      messages: [
        {
          ts: '1.001',
          text: 'mesh reply',
          metadata: {
            event_type: 'mesh_output',
            event_payload: { agent: 'rook', trace_id: 'trc_1' },
          },
        },
      ],
    }))
    const client = { conversations: { replies } } as unknown as WebClient
    const gateway = new WebApiGateway({
      token: 'unused',
      botUserId: 'U_MESH',
      logger: new Logger({ sink: () => undefined }),
      client,
    })

    const messages = await gateway.readThread({ channel: 'C1', threadTs: '1.000' })

    expect(replies).toHaveBeenCalledWith(expect.objectContaining({ include_all_metadata: true }))
    expect(messages).toEqual([
      expect.objectContaining({ agent: 'rook', isMesh: true, text: 'mesh reply' }),
    ])
  })
})
