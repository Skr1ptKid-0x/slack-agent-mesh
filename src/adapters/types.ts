/** Everything an adapter needs to invoke the underlying agent. */
export interface AdapterRequest {
  agent: string
  /** The fully-composed prompt (human text or delegating agent text). */
  prompt: string
  trace: {
    traceId: string
    hop: number
    channel: string
    threadTs: string
    /** Causal Slack event/message identifier used for dedupe and trace provenance. */
    from: string
  }
}

export type AdapterErrorKind =
  | 'timeout'
  | 'nonzero_exit'
  | 'output_cap'
  | 'bad_response'
  | 'transport'
  | 'misconfigured'

export type AdapterResult =
  | { ok: true; text: string }
  | { ok: false; kind: AdapterErrorKind; error: string }

/**
 * A transport to an existing agent. The mesh never imports a model SDK; every
 * "brain" is reached through one of these. Implementations MUST fail closed:
 * on timeout, over-cap output, non-zero exit, or malformed response they return
 * `{ ok: false, ... }` rather than throwing or hanging.
 */
export interface Adapter {
  readonly name: string
  readonly kind: 'command' | 'webhook' | 'mock'
  invoke(req: AdapterRequest): Promise<AdapterResult>
}
