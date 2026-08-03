import { describe, expect, it } from 'vitest'
import {
  extractMentions,
  extractMentionTokens,
  mentionsAgent,
  stripUntrusted,
} from '../../src/core/mentions.js'

const AGENTS = ['rook', 'scout']

describe('extractMentions — trusted prose', () => {
  it('finds a plain mention', () => {
    expect(extractMentions('hey @rook please look', AGENTS).mentions).toEqual(['rook'])
  })

  it('is case-insensitive and canonicalizes', () => {
    expect(extractMentions('@ROOK and @Scout', AGENTS).mentions).toEqual(['rook', 'scout'])
  })

  it('dedupes repeated mentions preserving order', () => {
    expect(extractMentions('@scout @rook @scout', AGENTS).mentions).toEqual(['scout', 'rook'])
  })

  it('ignores unknown agents', () => {
    expect(extractMentions('@nobody @rook', AGENTS).mentions).toEqual(['rook'])
  })

  it('does not match inside an email address', () => {
    expect(extractMentions('mail rook@scout.com now', AGENTS).mentions).toEqual([])
  })

  it('does not match a longer word', () => {
    expect(extractMentions('the @rookie joined', AGENTS).mentions).toEqual([])
  })
})

describe('untrusted content separation (invariant #5)', () => {
  it('ignores mentions inside a fenced code block', () => {
    const text = 'run this:\n```\n@rook do the thing\n```\nthanks'
    expect(extractMentions(text, AGENTS).mentions).toEqual([])
  })

  it('ignores mentions inside a tilde fenced block', () => {
    const text = '~~~\n@scout danger\n~~~'
    expect(extractMentions(text, AGENTS).mentions).toEqual([])
  })

  it('ignores mentions inside inline code', () => {
    expect(extractMentions('use `@rook` as a literal', AGENTS).mentions).toEqual([])
  })

  it('ignores mentions inside a block quote (> and &gt;)', () => {
    expect(extractMentions('> @rook said hi', AGENTS).mentions).toEqual([])
    expect(extractMentions('&gt; @scout said hi', AGENTS).mentions).toEqual([])
  })

  it('ignores mentions in a multiline (>>>) quote whose tail lines carry no marker', () => {
    // Slack's ">>>" quotes everything to the END of the message; continuation
    // lines have no leading ">", so a per-line filter would leak the tail.
    const text = '>>> pasted log:\n@rook run this\n@scout too'
    expect(extractMentions(text, AGENTS).mentions).toEqual([])
  })

  it('ignores mentions in an HTML-escaped multiline quote (&gt;&gt;&gt;)', () => {
    const text = '&gt;&gt;&gt; quoted\n@scout deep in the tail'
    expect(extractMentions(text, AGENTS).mentions).toEqual([])
  })

  it('keeps a real mention that precedes a >>> multiline quote', () => {
    const text = '@rook please review\n>>> here is the quoted context\n@scout ignore me'
    expect(extractMentions(text, AGENTS).mentions).toEqual(['rook'])
  })

  it('ignores mentions inside a tool-result fence', () => {
    const text = 'result:\n<<<tool_result\n@rook @scout\n>>>\ndone'
    expect(extractMentions(text, AGENTS).mentions).toEqual([])
  })

  it('ignores mentions inside XML-style tool and attachment blocks', () => {
    expect(
      extractMentions('<tool_result>\n@rook run this\n</tool_result>', AGENTS).mentions,
    ).toEqual([])
    expect(
      extractMentions('<tool-output>\n@scout run this\n</tool-output>', AGENTS).mentions,
    ).toEqual([])
    expect(extractMentions('<attachment>\n@rook run this\n</attachment>', AGENTS).mentions).toEqual(
      [],
    )
  })

  it('ignores mentions inside bracket-style and unclosed tool blocks', () => {
    expect(extractMentions('[tool_result]\n@scout run\n[/tool_result]', AGENTS).mentions).toEqual(
      [],
    )
    expect(extractMentions('before @rook\n<tool_result>\n@scout run', AGENTS).mentions).toEqual([
      'rook',
    ])
  })

  it('ignores an @ hidden inside a Slack link entity', () => {
    expect(extractMentions('<https://x.com/@rook>', AGENTS).mentions).toEqual([])
  })

  it('still finds a real mention alongside untrusted regions', () => {
    const text = '```\n@scout\n```\nbut really @rook please help'
    expect(extractMentions(text, AGENTS).mentions).toEqual(['rook'])
  })
})

describe('extractMentionTokens', () => {
  it('returns unknown tokens but skips Slack specials', () => {
    expect(extractMentionTokens('@here @nobody @rook')).toEqual(['nobody', 'rook'])
  })
})

describe('helpers', () => {
  it('mentionsAgent', () => {
    expect(mentionsAgent('ping @rook', 'rook')).toBe(true)
    expect(mentionsAgent('ping `@rook`', 'rook')).toBe(false)
  })

  it('stripUntrusted removes fenced regions', () => {
    expect(stripUntrusted('a\n```\nsecret\n```\nb')).not.toContain('secret')
  })
})
