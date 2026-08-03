import { describe, expect, it } from 'vitest'
import { extractMentions } from '../../src/core/mentions.js'
import {
  boundText,
  EMPTY_BODY_PLACEHOLDER,
  formatBoundedAgentText,
  SLACK_MAX_TEXT,
  TRUNCATION_MARKER,
} from '../../src/core/text.js'

describe('boundText', () => {
  it('returns short text unchanged', () => {
    expect(boundText('hello', 100)).toBe('hello')
  })

  it('truncates with a visible marker and never exceeds the limit', () => {
    const out = boundText('x'.repeat(200), 50)
    expect(out.length).toBe(50)
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true)
  })
})

describe('formatBoundedAgentText', () => {
  it('charges the prefix against the budget: formatted <= limit exactly', () => {
    const agent = 'rook'
    const { formatted, body } = formatBoundedAgentText(agent, 'y'.repeat(SLACK_MAX_TEXT * 2))
    // The ACTUAL Slack payload (prefix + body) must fit, not just the raw body.
    expect(formatted.length).toBeLessThanOrEqual(SLACK_MAX_TEXT)
    expect(formatted.startsWith(`*@${agent}*: `)).toBe(true)
    // The scanned body excludes the prefix and is itself bounded.
    expect(body.length).toBeLessThanOrEqual(SLACK_MAX_TEXT)
    expect(formatted).toBe(`*@${agent}*: ${body}`)
  })

  it('renders the empty placeholder but scans an empty body', () => {
    const { formatted, body } = formatBoundedAgentText('rook', '')
    expect(formatted).toBe(`*@rook*: ${EMPTY_BODY_PLACEHOLDER}`)
    expect(body).toBe('')
    expect(extractMentions(body, ['scout']).mentions).toEqual([])
  })

  it('a mention only in the truncated tail is absent from both payload and body', () => {
    // The @scout token sits well past the 40k cap, so it survives in neither the
    // visible Slack text nor the fan-out body — it must not be routable.
    const tail = ' @scout please help'
    const text = 'z'.repeat(SLACK_MAX_TEXT + 500) + tail
    const { formatted, body } = formatBoundedAgentText('rook', text)
    expect(formatted.length).toBeLessThanOrEqual(SLACK_MAX_TEXT)
    expect(formatted).not.toContain('@scout')
    expect(body).not.toContain('@scout')
    expect(extractMentions(body, ['scout']).mentions).toEqual([])
  })

  it('a mention within the cap still routes', () => {
    const { body } = formatBoundedAgentText('rook', 'please loop in @scout on this')
    expect(extractMentions(body, ['scout']).mentions).toEqual(['scout'])
  })
})
