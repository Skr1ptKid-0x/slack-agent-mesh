import { z } from 'zod'

/**
 * Configuration schema. A guiding rule: config references environment-variable
 * *names* (e.g. `bot_token_env: SLACK_BOT_TOKEN`), never token values. Inline
 * secrets are rejected by {@link assertNoInlineSecrets} before this schema runs.
 */

const agentName = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'agent name must be lowercase alphanumeric with - or _')

const commandAdapter = z.object({
  type: z.literal('command'),
  /** argv: first element is the executable, rest are static args. */
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().optional(),
  /** Hard wall-clock timeout for the child process. */
  timeout_ms: z.number().int().positive().max(600_000).default(60_000),
  /** Maximum bytes of stdout accepted; exceeding this fails the turn closed. */
  max_output_bytes: z.number().int().positive().max(10_000_000).default(65_536),
  /** Explicit allowlist of env var names passed through to the child. */
  env_allowlist: z.array(z.string()).default([]),
  /** Static extra env NAMES to resolve from process env and forward. */
  env_pass: z.array(z.string()).default([]),
})

const webhookAdapter = z.object({
  type: z.literal('webhook'),
  /** Name of the env var holding the target URL. */
  url_env: z.string().min(1),
  /** Name of the env var holding the required HMAC signing secret. */
  secret_env: z.string().min(1),
  timeout_ms: z.number().int().positive().max(600_000).default(30_000),
  max_output_bytes: z.number().int().positive().max(10_000_000).default(65_536),
})

const mockReply = z.object({
  when_prompt_contains: z.string().min(1).optional(),
  reply: z.string(),
})

const mockAdapter = z.object({
  type: z.literal('mock'),
  /** Default reply when no rule matches. */
  reply: z.string().default(''),
  /** Ordered rules; first whose substring matches wins. */
  replies: z.array(mockReply).default([]),
  /** Optional artificial delay to exercise queueing (ms). */
  delay_ms: z.number().int().min(0).max(60_000).default(0),
})

export const adapterSchema = z.discriminatedUnion('type', [
  commandAdapter,
  webhookAdapter,
  mockAdapter,
])

export const agentSchema = z.object({
  name: agentName,
  description: z.string().default(''),
  /** Optional presence/status string surfaced by directory tools. */
  presence: z.string().optional(),
  adapter: adapterSchema,
})

export const slackSchema = z
  .object({
    bot_token_env: z.string().min(1).default('SLACK_BOT_TOKEN'),
    app_token_env: z.string().min(1).default('SLACK_APP_TOKEN'),
    signing_secret_env: z.string().min(1).default('SLACK_SIGNING_SECRET'),
  })
  .default({})

export const meshSchema = z.object({
  max_hops: z.number().int().min(1).max(64).default(4),
  max_messages: z.number().int().min(1).max(256).default(12),
  trace_ttl_seconds: z.number().int().min(1).max(86_400).default(3_600),
  debug: z.boolean().default(false),
  /** Path to the SQLite state file; ':memory:' for ephemeral runs. */
  state_path: z.string().default('.mesh/state.sqlite'),
  /**
   * Slack user ids allowed to start a turn. Empty rejects every sender unless
   * `allow_any_user` is true, so a missing list fails closed.
   */
  allowed_users: z.array(z.string().min(1)).default([]),
  /**
   * Slack channel ids (including DM ids) the mesh acts in. Empty rejects every
   * channel unless `allow_any_channel` is true.
   */
  allowed_channels: z.array(z.string().min(1)).default([]),
  /** Explicit opt-in to admit any non-bot user when `allowed_users` is empty. */
  allow_any_user: z.boolean().default(false),
  /** Explicit opt-in to act in any channel or DM when `allowed_channels` is empty. */
  allow_any_channel: z.boolean().default(false),
  slack: slackSchema,
})

export const configSchema = z
  .object({
    mesh: meshSchema.default({}),
    agents: z.array(agentSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const names = new Set<string>()
    for (const [i, agent] of cfg.agents.entries()) {
      if (names.has(agent.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate agent name "${agent.name}"`,
          path: ['agents', i, 'name'],
        })
      }
      names.add(agent.name)
    }
  })

export type MeshConfig = z.infer<typeof configSchema>
export type AgentConfig = z.infer<typeof agentSchema>
export type AdapterConfig = z.infer<typeof adapterSchema>
export type CommandAdapterConfig = z.infer<typeof commandAdapter>
export type WebhookAdapterConfig = z.infer<typeof webhookAdapter>
export type MockAdapterConfig = z.infer<typeof mockAdapter>

/** Patterns that indicate a real secret was pasted into config instead of a name. */
const INLINE_SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'Slack bot token (xoxb-)', re: /xoxb-[A-Za-z0-9-]{5,}/ },
  { label: 'Slack app token (xapp-)', re: /xapp-[A-Za-z0-9-]{5,}/ },
  { label: 'Slack user token (xoxp-)', re: /xoxp-[A-Za-z0-9-]{5,}/ },
  { label: 'Slack legacy token (xoxa-/xoxr-)', re: /xox[ar]-[A-Za-z0-9-]{5,}/ },
]

/** Keys whose value is expected to be a secret and must therefore be an env NAME. */
const SECRET_BEARING_KEY = /(token|secret|signing|password|api[_-]?key)$/i
/** A value that looks like an env var name (what a *_env field must contain). */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/

/**
 * Reject configs that embed live secrets. Walks the raw parsed object and throws
 * on any token-shaped string, or any secret-bearing key whose value is clearly a
 * literal rather than an env-var name.
 */
export function assertNoInlineSecrets(raw: unknown, path: string[] = []): void {
  if (typeof raw === 'string') {
    for (const { label, re } of INLINE_SECRET_PATTERNS) {
      if (re.test(raw)) {
        throw new ConfigSecretError(
          `Inline secret detected at ${path.join('.') || '<root>'}: looks like a ${label}. ` +
            'Config must reference environment-variable names, not token values.',
        )
      }
    }
    return
  }
  if (Array.isArray(raw)) {
    raw.forEach((v, i) => {
      assertNoInlineSecrets(v, [...path, String(i)])
    })
    return
  }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      // A *_env field, or any secret-bearing key, must hold an env NAME.
      const isEnvField = k.endsWith('_env')
      const isSecretKey = SECRET_BEARING_KEY.test(k)
      if ((isEnvField || isSecretKey) && typeof v === 'string' && v.length > 0) {
        if (!ENV_NAME.test(v)) {
          throw new ConfigSecretError(
            `Field "${[...path, k].join('.')}" must be an environment-variable NAME ` +
              `(e.g. SLACK_BOT_TOKEN), got a literal value. Never place secrets in config.`,
          )
        }
      }
      assertNoInlineSecrets(v, [...path, k])
    }
  }
}

export class ConfigSecretError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigSecretError'
  }
}

export class ConfigValidationError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(`Invalid mesh config:\n - ${issues.join('\n - ')}`)
    this.name = 'ConfigValidationError'
    this.issues = issues
  }
}
