import { buildAdapterMap } from './adapters/registry.js'
import type { Adapter } from './adapters/types.js'
import { Broker } from './broker/broker.js'
import type { MeshConfig } from './config/schema.js'
import { Logger } from './core/logger.js'
import { registerSecret } from './core/redact.js'
import { Router, type RouterOptions } from './core/router.js'
import { MockGateway, type SlackGateway } from './slack/gateway.js'
import { SqliteStore } from './store/sqlite.js'
import type { Store } from './store/store.js'

export interface RuntimeOptions {
  config: MeshConfig
  env?: NodeJS.ProcessEnv
  /** Override the outbound Slack surface (mock for demo/tests). */
  gateway?: SlackGateway
  /** Override the store (defaults to a SQLite store at config.mesh.state_path). */
  store?: Store
  logger?: Logger
  routerOptions?: RouterOptions
  /** Override adapters (tests inject deterministic ones). */
  adapters?: Map<string, Adapter>
}

/** A fully-wired mesh instance sharing one store, router, and gateway. */
export interface Mesh {
  config: MeshConfig
  store: Store
  router: Router
  gateway: SlackGateway
  adapters: Map<string, Adapter>
  broker: Broker
  logger: Logger
  close(): void
}

/**
 * Assemble a mesh from config. Registers any Slack secrets present in the env
 * with the redactor so they can never leak into logs, then builds the store,
 * router, adapters, gateway, and broker as one coherent unit.
 */
export function createMesh(opts: RuntimeOptions): Mesh {
  const env = opts.env ?? process.env
  const config = opts.config

  // Register secret VALUES (resolved from the env NAMES in config) for redaction.
  registerSecret(env[config.mesh.slack.bot_token_env])
  registerSecret(env[config.mesh.slack.app_token_env])
  registerSecret(env[config.mesh.slack.signing_secret_env])

  const logger = opts.logger ?? new Logger({ debug: config.mesh.debug, level: 'info' })
  const store = opts.store ?? new SqliteStore(config.mesh.state_path)
  const router = new Router(config, store, logger, opts.routerOptions)
  const adapters = opts.adapters ?? buildAdapterMap(config, env)
  const gateway = opts.gateway ?? new MockGateway()

  const broker = new Broker({ config, store, router, gateway, adapters, logger })

  return {
    config,
    store,
    router,
    gateway,
    adapters,
    broker,
    logger,
    close: () => store.close(),
  }
}
