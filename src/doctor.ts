import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, isAbsolute, resolve } from 'node:path'
import { loadConfig } from './config/load.js'
import type { MeshConfig } from './config/schema.js'

export interface DoctorCheck {
  name: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
}

export interface DoctorReport {
  ok: boolean
  checks: DoctorCheck[]
}

function findExecutable(
  command: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const suffixes =
    process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  const hasPath = command.includes('/') || command.includes('\\') || isAbsolute(command)
  const bases = hasPath
    ? [resolve(cwd ?? process.cwd(), command)]
    : (env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => resolve(dir, command))

  for (const base of bases) {
    for (const suffix of suffixes) {
      const candidate =
        suffix && !base.toUpperCase().endsWith(suffix.toUpperCase()) ? `${base}${suffix}` : base
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Try the next PATH entry or platform suffix.
      }
    }
  }
  return undefined
}

/**
 * Preflight diagnostics: validate config (including the secret boundary), then
 * verify that every environment variable the config *references* is actually
 * present. Never prints secret values. Does not contact Slack unless asked.
 */
export function runDoctor(configPath: string, env: NodeJS.ProcessEnv = process.env): DoctorReport {
  const checks: DoctorCheck[] = []

  if (!existsSync(configPath)) {
    checks.push({ name: 'config file', status: 'fail', detail: `not found: ${configPath}` })
    return { ok: false, checks }
  }

  let config: MeshConfig
  try {
    config = loadConfig(configPath)
    checks.push({ name: 'config schema', status: 'ok', detail: 'valid, no inline secrets' })
  } catch (err) {
    checks.push({ name: 'config schema', status: 'fail', detail: (err as Error).message })
    return { ok: false, checks }
  }

  // Slack credentials (needed for `serve`, optional for `mcp`/`demo`).
  const slackEnv = [config.mesh.slack.bot_token_env, config.mesh.slack.app_token_env]
  for (const name of slackEnv) {
    checks.push(
      env[name]
        ? { name: `env ${name}`, status: 'ok', detail: 'set' }
        : { name: `env ${name}`, status: 'warn', detail: 'not set (required for `serve`)' },
    )
  }

  // Per-agent adapter requirements.
  for (const agent of config.agents) {
    const a = agent.adapter
    if (a.type === 'webhook') {
      checks.push(
        env[a.url_env]
          ? { name: `@${agent.name} url env ${a.url_env}`, status: 'ok', detail: 'set' }
          : {
              name: `@${agent.name} url env ${a.url_env}`,
              status: 'warn',
              detail: 'not set (webhook agent will fail closed)',
            },
      )
      if (!env[a.secret_env]) {
        checks.push({
          name: `@${agent.name} secret env ${a.secret_env}`,
          status: 'fail',
          detail: 'not set (signed webhook calls require it)',
        })
      }
    } else if (a.type === 'command') {
      const command = a.command[0] ?? ''
      const configuredCwd = a.cwd ? resolve(a.cwd) : undefined
      if (configuredCwd && !existsSync(configuredCwd)) {
        checks.push({
          name: `@${agent.name} cwd`,
          status: 'fail',
          detail: `not found: ${configuredCwd}`,
        })
      }
      const executable = findExecutable(command, configuredCwd, env)
      checks.push(
        executable
          ? {
              name: `@${agent.name} command`,
              status: 'ok',
              detail: `${executable} (timeout ${a.timeout_ms}ms, cap ${a.max_output_bytes}B)`,
            }
          : {
              name: `@${agent.name} command`,
              status: 'fail',
              detail: `executable not found or not runnable: ${command || '<empty>'}`,
            },
      )
      for (const name of new Set([...a.env_allowlist, ...a.env_pass])) {
        if (!env[name]) {
          checks.push({
            name: `@${agent.name} env ${name}`,
            status: 'warn',
            detail: 'not set (child will not receive it)',
          })
        }
      }
    } else {
      checks.push({ name: `@${agent.name} adapter`, status: 'ok', detail: 'mock' })
    }
  }

  checks.push({
    name: 'loop limits',
    status: 'ok',
    detail: `max_hops=${config.mesh.max_hops}, max_messages=${config.mesh.max_messages}, ttl=${config.mesh.trace_ttl_seconds}s`,
  })

  const ok = !checks.some((c) => c.status === 'fail')
  return { ok, checks }
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon = { ok: '✓', warn: '!', fail: '✗' } as const
  const lines = report.checks.map((c) => `  ${icon[c.status]} ${c.name}: ${c.detail}`)
  lines.push('')
  lines.push(report.ok ? 'doctor: OK' : 'doctor: FAILED')
  return lines.join('\n')
}
