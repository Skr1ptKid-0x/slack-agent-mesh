import bolt from '@slack/bolt'
import { WebClient } from '@slack/web-api'
import type { Logger } from '../core/logger.js'
import type { IngressMessage } from '../core/types.js'
import type { Mesh } from '../runtime.js'
import { normalizeSlackEvent, type RawSlackEvent } from './ingress.js'
import { WebApiGateway } from './web-gateway.js'

const { App } = bolt

export interface SlackTransportOptions {
  config: Mesh['config']
  logger: Logger
  env?: NodeJS.ProcessEnv
}

/** Resolve required Slack credentials from env NAMES declared in config. */
export function resolveSlackCredentials(
  config: Mesh['config'],
  env: NodeJS.ProcessEnv = process.env,
): { botToken: string; appToken: string } {
  const botToken = env[config.mesh.slack.bot_token_env]
  const appToken = env[config.mesh.slack.app_token_env]
  const missing: string[] = []
  if (!botToken) missing.push(config.mesh.slack.bot_token_env)
  if (!appToken) missing.push(config.mesh.slack.app_token_env)
  if (missing.length > 0) {
    throw new Error(
      `Missing Slack credentials in environment: ${missing.join(', ')}. ` +
        'Set them (see .env.example) before running `serve`.',
    )
  }
  return { botToken: botToken as string, appToken: appToken as string }
}

/**
 * Slack Socket Mode transport. No public ingress server is required: Bolt opens
 * an outbound WebSocket. Every inbound event is normalized and handed to the
 * broker; structural echoes are dropped in {@link normalizeSlackEvent}.
 */
export class SlackTransport {
  private readonly log: Logger
  private readonly env: NodeJS.ProcessEnv

  constructor(private readonly opts: SlackTransportOptions) {
    this.log = opts.logger
    this.env = opts.env ?? process.env
  }

  /**
   * Build the mesh with a real Slack gateway and start listening. Returns the
   * assembled mesh so the caller can close the store on shutdown.
   */
  async start(
    buildMesh: (gateway: WebApiGateway) => Mesh,
  ): Promise<{ mesh: Mesh; stop: () => Promise<void> }> {
    const { botToken, appToken } = resolveSlackCredentials(this.opts.config, this.env)

    // Identify our own bot user so we can drop self-echoes.
    const probe = new WebClient(botToken)
    const auth = await probe.auth.test()
    const botUserId = (auth.user_id as string) ?? 'UNKNOWN'
    this.log.info('authenticated with Slack', { botUserId, team: auth.team })

    const gateway = new WebApiGateway({ token: botToken, botUserId, logger: this.log })
    const mesh = buildMesh(gateway)

    const app = new App({ token: botToken, appToken, socketMode: true })

    const dispatch = async (raw: RawSlackEvent, eventId: string): Promise<void> => {
      const result = normalizeSlackEvent(raw, { eventId, botUserId })
      if (!result.ok) {
        this.log.logDebug('event dropped at ingress', { reason: result.reason })
        return
      }
      await mesh.broker.handleIngress(result.message)
    }

    app.event('app_mention', async ({ event, body }) => {
      await dispatch(
        { ...(event as unknown as RawSlackEvent), type: 'app_mention' },
        (body as { event_id?: string }).event_id ?? `${event.channel}:${event.ts}`,
      )
    })

    app.message(async ({ message, body }) => {
      await dispatch(
        { ...(message as unknown as RawSlackEvent), type: 'message' },
        (body as { event_id?: string }).event_id ?? `${message.channel}:${message.ts}`,
      )
    })

    app.command('/mesh', async ({ command, ack }) => {
      await ack()
      const msg: IngressMessage = {
        eventId: `slash:${command.trigger_id}`,
        kind: 'slash_command',
        actor: 'human',
        senderId: command.user_id,
        channel: command.channel_id,
        // No thread anchor for slash commands; the first agent post becomes root.
        threadTs: '',
        ts: '',
        text: command.text ?? '',
        explicitMeshAddress: true,
      }
      await mesh.broker.handleIngress(msg)
    })

    app.error(async (error) => {
      this.log.error('bolt error', { error: error.message })
    })

    await app.start()
    this.log.info('slack-agent-mesh is listening (Socket Mode)')

    return {
      mesh,
      stop: async () => {
        await app.stop()
        mesh.close()
      },
    }
  }
}
