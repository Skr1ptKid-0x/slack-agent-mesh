/**
 * Slack-safe text bounding.
 *
 * Slack silently truncates a `chat.postMessage` `text` field at ~40k
 * characters. If the broker scanned the *full* agent output for delegating
 * mentions but Slack only rendered a truncated prefix, an `@agent` hidden in
 * the invisible tail could route even though no human ever saw it. To keep what
 * is posted and what is scanned identical, we bound the text *once* — before
 * both the post and the fan-out — with an explicit, visible truncation marker.
 */

/** Slack's practical per-message `text` limit. */
export const SLACK_MAX_TEXT = 40_000

/** The visible marker appended when text is truncated. */
export const TRUNCATION_MARKER = ' … [truncated]'

/**
 * Bound `text` to `limit` characters (inclusive of the marker). Returns the
 * input unchanged when it already fits, otherwise a hard-truncated prefix with
 * {@link TRUNCATION_MARKER} appended so both readers and the router see the
 * same bytes. The marker itself is never split.
 */
export function boundText(
  text: string,
  limit: number = SLACK_MAX_TEXT,
  marker: string = TRUNCATION_MARKER,
): string {
  if (text.length <= limit) return text
  // Reserve room for the marker; never emit a negative slice.
  const keep = Math.max(0, limit - marker.length)
  return text.slice(0, keep) + marker
}

/** The visible identity prefix an agent's message is rendered with. */
export function agentPrefix(agent: string): string {
  return `*@${agent}*: `
}

/** Placeholder body rendered when an agent produced no text. */
export const EMPTY_BODY_PLACEHOLDER = '_(no output)_'

/** Paired outputs of {@link formatBoundedAgentText}. */
export interface BoundedAgentText {
  /**
   * The EXACT string posted to Slack: the agent prefix followed by the bounded
   * body (or the empty-output placeholder). Guaranteed to be `<= limit` chars,
   * so Slack never silently truncates past what the mesh accounted for.
   */
  formatted: string
  /**
   * The EXACT visible body the router scans for delegating mentions and quotes
   * into a delegation prompt. It is the bounded body only — never the prefix or
   * the placeholder — so a mention that was truncated out of the Slack post is
   * likewise absent here and cannot route.
   */
  body: string
}

/**
 * Produce both the Slack payload and the fan-out body in one place so they can
 * never diverge.
 *
 * The naive approach — bound the raw body to 40k, then prepend `*@agent*: ` —
 * pushes the real payload past Slack's limit by the length of the prefix, so
 * Slack truncates a few trailing characters that the router still scanned. Here
 * the prefix is charged against the same budget: the body is bounded to
 * `limit - prefix.length`, and `formatted = prefix + body`. The result is that
 * `formatted.length <= limit` exactly, and any `@agent` past the cap is invisible
 * to BOTH the human reader and the delegation scanner.
 */
export function formatBoundedAgentText(
  agent: string,
  text: string,
  limit: number = SLACK_MAX_TEXT,
): BoundedAgentText {
  const prefix = agentPrefix(agent)
  // Charge the prefix against the total budget so prefix + body <= limit.
  const bodyLimit = Math.max(0, limit - prefix.length)
  const body = boundText(text, bodyLimit)
  const rendered = body.length > 0 ? body : EMPTY_BODY_PLACEHOLDER
  return { formatted: prefix + rendered, body }
}
