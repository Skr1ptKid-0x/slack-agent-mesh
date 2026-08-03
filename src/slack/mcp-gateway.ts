import { WebClient } from '@slack/web-api'
import type { MeshConfig } from '../config/schema.js'
import type { Logger } from '../core/logger.js'
import { MockGateway, type SlackGateway } from './gateway.js'
import { WebApiGateway } from './web-gateway.js'

export interface McpGatewayOptions {
  config: MeshConfig
  env?: NodeJS.ProcessEnv
  logger: Logger
  /** Injectable WebClient factory so tests can construct a live gateway without
   * touching the network. Defaults to a real `@slack/web-api` client. */
  makeClient?: (token: string) => WebClient
}

export interface ResolvedMcpGateway {
  gateway: SlackGateway
  /** True when a real Slack-backed gateway was built (a bot token was present). */
  live: boolean
}

/**
 * Choose the outbound gateway for the MCP server.
 *
 * The MCP surface only needs a *bot* token to POST — Socket Mode's app token is
 * for *receiving* events, which the MCP server never does. So when a bot token
 * is present we build a live {@link WebApiGateway} (resolving the bot user id via
 * `auth.test()`) and `mesh_send`/`mesh_reply` reach real Slack. With no token we
 * fall back to the in-memory {@link MockGateway} so an agent can still exercise
 * the tool surface locally and in the credential-free demo.
 *
 * The WebClient factory is injectable so this whole decision is unit-testable
 * without a network round-trip.
 */
export async function buildMcpGateway(opts: McpGatewayOptions): Promise<ResolvedMcpGateway> {
  const env = opts.env ?? process.env
  const tokenEnv = opts.config.mesh.slack.bot_token_env
  const token = env[tokenEnv]
  if (!token) {
    opts.logger.info('mcp: no Slack bot token; using in-memory gateway', { env: tokenEnv })
    return { gateway: new MockGateway(), live: false }
  }

  const makeClient = opts.makeClient ?? ((t: string) => new WebClient(t))
  const client = makeClient(token)
  const auth = await client.auth.test()
  const botUserId = (auth.user_id as string) ?? 'UNKNOWN'
  opts.logger.info('mcp: authenticated with Slack; using live gateway', { botUserId })
  return {
    gateway: new WebApiGateway({ token, botUserId, logger: opts.logger, client }),
    live: true,
  }
}
