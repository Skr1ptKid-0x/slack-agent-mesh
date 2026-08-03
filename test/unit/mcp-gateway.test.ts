import type { WebClient } from '@slack/web-api'
import { describe, expect, it, vi } from 'vitest'
import { validateConfig } from '../../src/config/load.js'
import { Logger } from '../../src/core/logger.js'
import { MockGateway } from '../../src/slack/gateway.js'
import { buildMcpGateway } from '../../src/slack/mcp-gateway.js'
import { WebApiGateway } from '../../src/slack/web-gateway.js'

function config() {
  return validateConfig({
    mesh: { state_path: ':memory:' },
    agents: [{ name: 'rook', adapter: { type: 'mock', reply: '' } }],
  })
}

const logger = new Logger({ sink: () => undefined })

describe('buildMcpGateway', () => {
  it('falls back to the in-memory mock gateway when no bot token is present', async () => {
    const makeClient = vi.fn()
    const res = await buildMcpGateway({ config: config(), env: {}, logger, makeClient })
    expect(res.live).toBe(false)
    expect(res.gateway).toBeInstanceOf(MockGateway)
    // With no token we must never construct a client / touch the network.
    expect(makeClient).not.toHaveBeenCalled()
  })

  it('builds a live gateway from an injected WebClient (no network)', async () => {
    const fakeBotToken = ['xoxb', '1234567890'].join('-')
    const postMessage = vi.fn(async () => ({ ok: true, ts: '111.222' }))
    const authTest = vi.fn(async () => ({ ok: true, user_id: 'U_BOT' }))
    const fakeClient = {
      auth: { test: authTest },
      chat: { postMessage },
    } as unknown as WebClient
    const makeClient = vi.fn(() => fakeClient)

    const res = await buildMcpGateway({
      config: config(),
      env: { SLACK_BOT_TOKEN: fakeBotToken },
      logger,
      makeClient,
    })

    expect(res.live).toBe(true)
    expect(res.gateway).toBeInstanceOf(WebApiGateway)
    // Bot user id is resolved from auth.test() through the injected client.
    expect(makeClient).toHaveBeenCalledWith(fakeBotToken)
    expect(authTest).toHaveBeenCalledTimes(1)
    expect(res.gateway.botUserId).toBe('U_BOT')

    // The live gateway routes posts through the SAME injected client.
    const posted = await res.gateway.postMessage({ channel: 'C1', text: 'hi' })
    expect(posted.ts).toBe('111.222')
    expect(postMessage).toHaveBeenCalledTimes(1)
  })
})
