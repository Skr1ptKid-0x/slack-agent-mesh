import { afterEach, describe, expect, it } from 'vitest'
import { Logger } from '../../src/core/logger.js'
import { clearRegisteredSecrets, registerSecret } from '../../src/core/redact.js'

afterEach(() => clearRegisteredSecrets())

describe('Logger redaction (invariant #8)', () => {
  it('redacts token-shaped strings in messages and fields', () => {
    const lines: string[] = []
    const log = new Logger({ level: 'debug', sink: (l) => lines.push(l) })
    const fakeBotToken = ['xoxb', '1234567890'].join('-')
    const fakeAppToken = ['xapp', '1234567890'].join('-')
    log.info(`starting with ${fakeBotToken}`, { token: fakeAppToken })
    const out = lines.join('\n')
    expect(out).not.toContain('abcdefghij')
    expect(out).toContain('[REDACTED')
  })

  it('scrubs a registered secret value', () => {
    const lines: string[] = []
    registerSecret('hunter2-hunter2')
    const log = new Logger({ level: 'debug', sink: (l) => lines.push(l) })
    log.info('value is hunter2-hunter2')
    expect(lines.join('')).not.toContain('hunter2-hunter2')
  })

  it('suppresses full prompts unless debug is enabled', () => {
    const quiet = new Logger({ debug: false })
    expect(quiet.promptForLog('a very secret prompt body')).toBe('<25 chars, redacted>')
    const loud = new Logger({ debug: true })
    expect(loud.promptForLog('visible prompt')).toBe('visible prompt')
  })
})
