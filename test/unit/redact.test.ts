import { afterEach, describe, expect, it } from 'vitest'
import {
  clearRegisteredSecrets,
  redactString,
  redactValue,
  registerSecret,
} from '../../src/core/redact.js'

afterEach(() => clearRegisteredSecrets())

const fakeBotToken = ['xoxb', '1234567890'].join('-')
const fakeAppToken = ['xapp', '1234567890'].join('-')
const fakeUserToken = ['xoxp', '1234567890'].join('-')

describe('redactString — Slack token classes', () => {
  it('redacts a bot token', () => {
    const out = redactString(`token is ${fakeBotToken} here`)
    expect(out).toContain('[REDACTED:xoxb]')
    expect(out).not.toContain('abcdefghijklmnop')
  })

  it('redacts app and user tokens', () => {
    expect(redactString(fakeAppToken)).toContain('[REDACTED:xapp]')
    expect(redactString(fakeUserToken)).toContain('[REDACTED:xoxp]')
  })

  it('redacts a 32+ char hex signing-secret-shaped string', () => {
    const secret = 'a'.repeat(40)
    expect(redactString(`sig=${secret}`)).toContain('[REDACTED:hex]')
  })
})

describe('registered secret values', () => {
  it('scrubs a registered secret from arbitrary text', () => {
    registerSecret('super-secret-value-123')
    expect(redactString('leak: super-secret-value-123')).toContain('[REDACTED:secret]')
  })

  it('ignores too-short secrets', () => {
    registerSecret('abc')
    expect(redactString('value abc')).toContain('abc')
  })
})

describe('redactValue — deep', () => {
  it('redacts secret-bearing keys wholesale', () => {
    const out = redactValue({ signing_secret: 'plainish', nested: { token: 'zzz' } }) as Record<
      string,
      unknown
    >
    expect(out.signing_secret).toBe('[REDACTED:key]')
    expect((out.nested as Record<string, unknown>).token).toBe('[REDACTED:key]')
  })

  it('recurses arrays and redacts token strings in place', () => {
    const out = redactValue(['ok', fakeBotToken]) as string[]
    expect(out[0]).toBe('ok')
    expect(out[1]).toContain('[REDACTED:xoxb]')
  })
})
