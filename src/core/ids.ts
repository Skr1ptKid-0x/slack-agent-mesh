import { createHash, randomUUID } from 'node:crypto'

/** Generate a fresh trace id. Prefixed so it is recognizable in logs. */
export function newTraceId(): string {
  return `trc_${randomUUID()}`
}

/**
 * Deterministic idempotency key for an agent output. Two retries of the same
 * logical turn (same trace, agent, and cause event) must collapse to one key so
 * the store rejects the duplicate visible post.
 */
export function outputKey(parts: { traceId: string; agent: string; causeEventId: string }): string {
  return hashKey(['out', parts.traceId, parts.agent, parts.causeEventId])
}

/** Deterministic key for a delegation edge, used to dedupe fan-out enqueues. */
export function delegationKey(parts: {
  traceId: string
  fromAgent: string
  toAgent: string
  causeEventId: string
}): string {
  return hashKey(['deleg', parts.traceId, parts.fromAgent, parts.toAgent, parts.causeEventId])
}

/** Stable hash of ordered string parts. */
export function hashKey(parts: string[]): string {
  const h = createHash('sha256')
  for (const p of parts) {
    h.update(p)
    h.update('\0')
  }
  return h.digest('hex').slice(0, 32)
}
