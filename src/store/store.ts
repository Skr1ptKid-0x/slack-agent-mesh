import type { OutputReceipt, TraceRecord } from '../core/types.js'

/**
 * Durable coordination state. Every loop-prevention and idempotency guarantee
 * is backed here so a process restart or a Slack retry cannot replay a turn.
 */
export interface Store {
  /**
   * Record that an event id has been observed. Returns true if this is the first
   * time (proceed), false if it is a duplicate (reject before any adapter runs).
   */
  recordEvent(eventId: string): boolean

  getTrace(traceId: string): TraceRecord | undefined
  createTrace(rec: TraceRecord): void
  updateTrace(rec: TraceRecord): void

  /** True if the agent has already run in this trace. */
  hasVisited(traceId: string, agent: string): boolean
  /** Mark an agent visited. Returns true if newly added, false if already present. */
  addVisited(traceId: string, agent: string): boolean
  /** All agents that have run in a trace, in insertion order. */
  getVisited(traceId: string): string[]

  /** Existing *finalized* receipt for an output key, if a visible post was
   * already made. Pending (unfinalized) claims are never returned here. */
  getOutput(outputKey: string): OutputReceipt | undefined
  putOutput(receipt: OutputReceipt): void

  /**
   * Atomically reserve an output key *before* a visible Slack post. Returns
   * `claimed: true` only for the first caller; a concurrent or duplicate caller
   * gets `claimed: false` and must not post. The claim is a pending row that is
   * later {@link finalizeOutput}'d on success or {@link releaseOutput}'d on
   * failure. This is the exactly-one-post guard for concurrent injections.
   */
  claimOutput(input: { outputKey: string; channel: string; createdAt: number }): {
    claimed: boolean
  }
  /** Promote a claimed key to a finalized receipt after a successful post. */
  finalizeOutput(receipt: OutputReceipt): void
  /** Drop a pending claim (post failed) so a later retry can proceed. Never
   * removes a finalized receipt. */
  releaseOutput(outputKey: string): void

  /** Returns true if this delegation edge was already enqueued once. */
  recordDelegation(key: string): boolean

  /**
   * Mark a Slack thread as an active agent thread owned by the mesh, recording
   * the first agent to speak in it. Idempotent: the first registration wins.
   */
  registerThread(channel: string, threadTs: string, primaryAgent: string): void
  /** Ownership record for a thread, if the mesh has posted into it. */
  getThread(channel: string, threadTs: string): ThreadRecord | undefined

  close(): void
}

export interface ThreadRecord {
  channel: string
  threadTs: string
  primaryAgent: string
  createdAt: number
}
