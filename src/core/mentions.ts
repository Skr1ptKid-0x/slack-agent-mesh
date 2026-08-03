/**
 * Safe mention extraction.
 *
 * Invariant #5 / adversarial contract: an `@agent` token only delegates when it
 * appears in *trusted* prose. Mentions inside fenced code, inline code, block
 * quotes, Slack quoted-attachment text, or tool-result blocks must never wake an
 * agent. We strip every untrusted region *before* scanning, so a crafted payload
 * cannot smuggle a delegation through quoted content.
 */

export interface MentionScanResult {
  /** Distinct configured-agent names mentioned in trusted text, in first-seen order. */
  mentions: string[]
  /** The text with untrusted regions removed (useful for tests/debugging). */
  trustedText: string
}

/** A fenced code block: ``` or ~~~ delimited, across lines. */
const FENCED_CODE = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g
/** Inline code: single/multi backtick spans on one line. */
const INLINE_CODE = /`[^`\n]+`/g
/** A tool-result / attachment fence some agents emit, e.g. <<<tool_result ... >>>. */
const TOOL_RESULT_BLOCK = /<<<[a-z_]*(?:result|output|attachment)[\s\S]*?>>>/gi
/** XML-style tool/attachment blocks, including an unclosed block through EOF. */
const TOOL_RESULT_XML = /<(tool[_-]?(?:result|output)|attachment)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi
/** Bracket-style tool/attachment blocks, including an unclosed block through EOF. */
const TOOL_RESULT_BRACKET = /\[(tool[_-]?(?:result|output)|attachment)\][\s\S]*?(?:\[\/\1\]|$)/gi

/**
 * Remove untrusted regions from text. Order matters: fenced blocks first (they
 * may contain backticks), then tool-result fences, inline code, then quotes.
 */
export function stripUntrusted(text: string): string {
  let out = text.replace(FENCED_CODE, '\n')
  out = out.replace(TOOL_RESULT_BLOCK, ' ')
  out = out.replace(TOOL_RESULT_XML, ' ')
  out = out.replace(TOOL_RESULT_BRACKET, ' ')
  out = out.replace(INLINE_CODE, ' ')
  // Drop Slack rich entities like <@U123>, <#C1|name>, <https://...> so an "@"
  // hidden inside a URL or user-id cannot be read as a virtual mention.
  out = out.replace(/<[^>\n]*>/g, ' ')
  // Remove block quotes. Slack has two forms:
  //  - single-line ">" (or HTML-escaped "&gt;"), one quoted line at a time;
  //  - multiline ">>>" (or "&gt;&gt;&gt;"), which quotes everything from that
  //    marker to the END of the message. The continuation lines of a ">>>"
  //    block carry no leading ">", so a naive per-line filter would leave an
  //    "@agent" in the quoted tail routable. Once a ">>>" marker is seen we drop
  //    the rest of the message entirely.
  const kept: string[] = []
  for (const line of out.split('\n')) {
    const trimmed = line.replace(/^\s+/, '')
    if (trimmed.startsWith('>>>') || trimmed.startsWith('&gt;&gt;&gt;')) break
    if (trimmed.startsWith('>') || trimmed.startsWith('&gt;')) continue
    kept.push(line)
  }
  out = kept.join('\n')
  return out
}

/** Slack keyword mentions that are never agent delegations. */
const SLACK_SPECIALS = new Set(['here', 'channel', 'everyone'])

/**
 * All `@token` names found in *trusted* prose (lowercased, de-duplicated, in
 * first-seen order), excluding Slack keyword specials. Used to distinguish an
 * unknown-agent mention from ordinary text with no mentions at all.
 */
export function extractMentionTokens(text: string): string[] {
  const trustedText = stripUntrusted(text)
  const seen = new Set<string>()
  const out: string[] = []
  const re = /(?<![\w@/])@([a-z0-9][a-z0-9_-]*)/gi
  for (const match of trustedText.matchAll(re)) {
    const raw = match[1]?.toLowerCase()
    if (!raw || SLACK_SPECIALS.has(raw) || seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
}

/**
 * Extract configured-agent mentions from trusted prose.
 *
 * @param text          message body
 * @param knownAgents   set/array of configured agent names (case-insensitive)
 */
export function extractMentions(text: string, knownAgents: Iterable<string>): MentionScanResult {
  const known = new Map<string, string>()
  for (const name of knownAgents) known.set(name.toLowerCase(), name)

  const trustedText = stripUntrusted(text)
  const seen = new Set<string>()
  const mentions: string[] = []

  // Preceding char must not be a word char, "@", or "/" (guards emails, paths,
  // and double-@). Name starts alnum, then alnum/_/-.
  const re = /(?<![\w@/])@([a-z0-9][a-z0-9_-]*)/gi
  for (const match of trustedText.matchAll(re)) {
    const raw = match[1]
    if (!raw) continue
    const canonical = known.get(raw.toLowerCase())
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical)
      mentions.push(canonical)
    }
  }

  return { mentions, trustedText }
}

/** Convenience: does trusted text mention this specific agent? */
export function mentionsAgent(text: string, agent: string): boolean {
  return extractMentions(text, [agent]).mentions.length > 0
}
