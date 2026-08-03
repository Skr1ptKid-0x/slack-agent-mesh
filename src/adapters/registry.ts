import type { AgentConfig, MeshConfig } from '../config/schema.js'
import { CommandAdapter } from './command.js'
import { MockAdapter } from './mock.js'
import type { Adapter } from './types.js'
import { WebhookAdapter } from './webhook.js'

/** Build a single adapter from an agent's config. */
export function buildAdapter(agent: AgentConfig, env: NodeJS.ProcessEnv = process.env): Adapter {
  switch (agent.adapter.type) {
    case 'command':
      return new CommandAdapter(agent.name, agent.adapter, env)
    case 'webhook':
      return new WebhookAdapter(agent.name, agent.adapter, env)
    case 'mock':
      return new MockAdapter(agent.name, agent.adapter)
  }
}

/** Build a name -> adapter map for every agent in the config. */
export function buildAdapterMap(
  config: MeshConfig,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, Adapter> {
  const map = new Map<string, Adapter>()
  for (const agent of config.agents) {
    map.set(agent.name, buildAdapter(agent, env))
  }
  return map
}
