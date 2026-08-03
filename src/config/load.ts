import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import {
  assertNoInlineSecrets,
  ConfigValidationError,
  configSchema,
  type MeshConfig,
} from './schema.js'

/** Validate an already-parsed config object (enforces the secret boundary). */
export function validateConfig(raw: unknown): MeshConfig {
  // Secret boundary is enforced on the RAW object first, before any coercion.
  assertNoInlineSecrets(raw)
  const result = configSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    throw new ConfigValidationError(issues)
  }
  return result.data
}

/** Parse and validate mesh config from a YAML/JSON string. */
export function parseConfig(source: string): MeshConfig {
  return validateConfig(parseYaml(source) as unknown)
}

/** Load and validate mesh config from a file path. */
export function loadConfig(path: string): MeshConfig {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(
      `Could not read config file at "${path}": ${(err as Error).message}. ` +
        'Pass --config <path> or create mesh.config.yaml.',
    )
  }
  return parseConfig(text)
}

/** Look up an agent by name (case-insensitive). */
export function findAgent(config: MeshConfig, name: string) {
  const lc = name.toLowerCase()
  return config.agents.find((a) => a.name.toLowerCase() === lc)
}

/** The set of configured agent names. */
export function agentNames(config: MeshConfig): string[] {
  return config.agents.map((a) => a.name)
}
