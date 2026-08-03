import { describe, expect, it } from 'vitest'
import { parseConfig } from '../../src/config/load.js'
import { ConfigSecretError, ConfigValidationError } from '../../src/config/schema.js'

const BASE = `
agents:
  - name: rook
    adapter:
      type: mock
      reply: hi
`

describe('config secret boundary (invariant #8)', () => {
  it('accepts env-var NAMES', () => {
    const cfg = parseConfig(`
mesh:
  slack:
    bot_token_env: SLACK_BOT_TOKEN
    app_token_env: SLACK_APP_TOKEN
${BASE}`)
    expect(cfg.mesh.slack.bot_token_env).toBe('SLACK_BOT_TOKEN')
  })

  it('rejects a literal xoxb- token anywhere', () => {
    const fakeToken = ['xoxb', '1234567890'].join('-')
    expect(() => parseConfig(`mesh:\n  note: ${fakeToken}\n${BASE}`)).toThrow(ConfigSecretError)
  })

  it('rejects a literal xapp- token', () => {
    const fakeToken = ['xapp', '1234567890'].join('-')
    expect(() => parseConfig(`mesh:\n  slack:\n    app_token_env: ${fakeToken}\n${BASE}`)).toThrow(
      ConfigSecretError,
    )
  })

  it('rejects a *_env field that holds a literal instead of a NAME', () => {
    expect(() =>
      parseConfig(`mesh:\n  slack:\n    signing_secret_env: "actual-secret-value"\n${BASE}`),
    ).toThrow(ConfigSecretError)
  })

  it('rejects a secret-bearing key with a literal value', () => {
    expect(() =>
      parseConfig(`
agents:
  - name: rook
    adapter:
      type: webhook
      url_env: ROOK_URL
      secret_env: "literal-hmac-secret-here"
`),
    ).toThrow(ConfigSecretError)
  })
})

describe('config validation', () => {
  it('requires at least one agent', () => {
    expect(() => parseConfig('agents: []')).toThrow(ConfigValidationError)
  })

  it('rejects duplicate agent names', () => {
    expect(() =>
      parseConfig(`
agents:
  - name: rook
    adapter: { type: mock, reply: a }
  - name: rook
    adapter: { type: mock, reply: b }
`),
    ).toThrow(ConfigValidationError)
  })

  it('rejects an invalid agent name', () => {
    expect(() =>
      parseConfig(`agents:\n  - name: "Rook Bot"\n    adapter: { type: mock, reply: a }`),
    ).toThrow(ConfigValidationError)
  })

  it('requires every webhook adapter to name a signing-secret env var', () => {
    expect(() =>
      parseConfig(`
agents:
  - name: scout
    adapter:
      type: webhook
      url_env: SCOUT_URL
`),
    ).toThrow(ConfigValidationError)
  })

  it('applies defaults for loop limits', () => {
    const cfg = parseConfig(BASE)
    expect(cfg.mesh.max_hops).toBe(4)
    expect(cfg.mesh.max_messages).toBe(12)
    expect(cfg.mesh.trace_ttl_seconds).toBe(3600)
  })

  it('parses command adapter with an argv array', () => {
    const cfg = parseConfig(`
agents:
  - name: rook
    adapter:
      type: command
      command: ["hermes", "--stdin"]
      timeout_ms: 5000
`)
    const a = cfg.agents[0]!.adapter
    expect(a.type).toBe('command')
    if (a.type === 'command') expect(a.command).toEqual(['hermes', '--stdin'])
  })
})
