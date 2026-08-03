/**
 * Redaction utilities. Logs and snapshots must never leak Slack token classes
 * or other registered secret values. This is deliberately conservative: it is
 * cheap to over-redact a log line and expensive to leak a token.
 */

/** Slack token prefixes we recognize (bot, app, user, legacy, refresh, config). */
const SLACK_TOKEN_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'xoxb', re: /xoxb-[A-Za-z0-9-]{8,}/g },
  { label: 'xapp', re: /xapp-[A-Za-z0-9-]{8,}/g },
  { label: 'xoxp', re: /xoxp-[A-Za-z0-9-]{8,}/g },
  { label: 'xoxa', re: /xoxa-[A-Za-z0-9-]{8,}/g },
  { label: 'xoxr', re: /xoxr-[A-Za-z0-9-]{8,}/g },
  { label: 'xoxe', re: /xoxe(?:\.xox[a-z])?-[A-Za-z0-9-]{8,}/g },
]

/** Registered exact secret values (e.g. signing secret pulled from env). */
const registeredSecrets = new Set<string>()

/**
 * Register a secret value so it is scrubbed from any redacted output. Values
 * shorter than 6 chars are ignored to avoid pathological over-redaction.
 */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === 'string' && value.length >= 6) {
    registeredSecrets.add(value)
  }
}

export function clearRegisteredSecrets(): void {
  registeredSecrets.clear()
}

/** Redact a single string value. */
export function redactString(input: string): string {
  let out = input
  for (const { label, re } of SLACK_TOKEN_PATTERNS) {
    out = out.replace(re, `[REDACTED:${label}]`)
  }
  // Scrub exact registered secret values (longest first so substrings do not
  // leave fragments behind).
  const secrets = [...registeredSecrets].sort((a, b) => b.length - a.length)
  for (const secret of secrets) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join('[REDACTED:secret]')
    }
  }
  // Detect a bare 32+ char hex string that looks like a signing secret.
  out = out.replace(/\b[a-f0-9]{32,}\b/gi, (m) =>
    registeredSecretsLooksLikeToken(m) ? '[REDACTED:hex]' : m,
  )
  return out
}

/**
 * Heuristic: treat a long hex blob as a secret only when it is exactly the kind
 * of value that would be sensitive (>= 32 hex chars). We keep this narrow so
 * ordinary hex ids (sha prefixes we generate at 32 chars) are still redacted
 * defensively rather than leaked. Returns true for 32+ hex.
 */
function registeredSecretsLooksLikeToken(candidate: string): boolean {
  return candidate.length >= 32
}

/** Deep-redact an arbitrary JSON-serializable value for safe logging/snapshots. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') {
    return redactString(value) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v)) as unknown as T
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Redact whole values for obviously sensitive keys regardless of content.
      if (/token|secret|signing|password|apikey|api_key/i.test(k) && typeof v === 'string') {
        out[k] = '[REDACTED:key]'
      } else {
        out[k] = redactValue(v)
      }
    }
    return out as unknown as T
  }
  return value
}
