import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { WebhookAdapterConfig } from '../config/schema.js'
import type { Adapter, AdapterRequest, AdapterResult } from './types.js'

/** The response contract a remote agent must satisfy. */
const webhookResponseSchema = z.object({
  text: z.string(),
  /** Optional agent-declared trace echo; ignored for routing but logged. */
  trace_id: z.string().optional(),
})

/**
 * Calls a remote agent over signed HTTP. The request body is HMAC-SHA256 signed
 * so the receiver can authenticate the mesh. A missing secret fails closed.
 * Bounded by an AbortController timeout and an output cap; the response must
 * schema-validate or the turn fails closed.
 */
export class WebhookAdapter implements Adapter {
  readonly kind = 'webhook' as const
  private readonly url: string | undefined
  private readonly secret: string | undefined

  constructor(
    readonly name: string,
    private readonly cfg: WebhookAdapterConfig,
    env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Injectable clock for deterministic signature tests. */
    private readonly now: () => number = Date.now,
  ) {
    this.url = env[cfg.url_env]
    this.secret = env[cfg.secret_env]
  }

  /** Compute the signature header value for a body + timestamp. */
  static sign(secret: string, timestamp: string, body: string): string {
    const mac = createHmac('sha256', secret)
    mac.update(`v0:${timestamp}:${body}`)
    return `v0=${mac.digest('hex')}`
  }

  /** Verify a signature (constant-time). Exposed for remote-agent SDK parity. */
  static verify(secret: string, timestamp: string, body: string, signature: string): boolean {
    const expected = WebhookAdapter.sign(secret, timestamp, body)
    const a = Buffer.from(expected)
    const b = Buffer.from(signature)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /**
   * Read a response body, aborting the request the instant the accumulated
   * bytes exceed the cap. Returns the decoded text on success, or an
   * `output_cap` signal without ever buffering the whole payload.
   */
  private async readCapped(
    res: Response,
    controller: AbortController,
  ): Promise<{ kind: 'ok'; text: string } | { kind: 'output_cap' }> {
    const cap = this.cfg.max_output_bytes
    const reader = res.body?.getReader()
    // No readable stream (e.g. an empty body): fall back to the buffered read,
    // still guarded by the cap.
    if (!reader) {
      const text = await res.text()
      if (Buffer.byteLength(text, 'utf8') > cap) return { kind: 'output_cap' }
      return { kind: 'ok', text }
    }
    const chunks: Buffer[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          total += value.byteLength
          if (total > cap) {
            controller.abort()
            await reader.cancel().catch(() => {})
            return { kind: 'output_cap' }
          }
          chunks.push(Buffer.from(value))
        }
      }
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* already released/cancelled */
      }
    }
    return { kind: 'ok', text: Buffer.concat(chunks).toString('utf8') }
  }

  async invoke(req: AdapterRequest): Promise<AdapterResult> {
    if (!this.url) {
      return {
        ok: false,
        kind: 'misconfigured',
        error: `webhook url env "${this.cfg.url_env}" is not set`,
      }
    }

    if (!this.secret) {
      return {
        ok: false,
        kind: 'misconfigured',
        error: `webhook secret env "${this.cfg.secret_env}" is not set`,
      }
    }

    const body = JSON.stringify({
      agent: req.agent,
      prompt: req.prompt,
      trace: req.trace,
    })
    const timestamp = String(Math.floor(this.now() / 1000))
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-mesh-timestamp': timestamp,
    }
    headers['x-mesh-signature'] = WebhookAdapter.sign(this.secret, timestamp, body)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.cfg.timeout_ms)
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })
      if (!res.ok) {
        return { ok: false, kind: 'transport', error: `HTTP ${res.status}` }
      }
      // Stream the body and enforce the byte cap incrementally: a hostile or
      // runaway remote agent must be cut off as soon as it crosses the limit,
      // not after its full (possibly unbounded) payload is buffered.
      const capped = await this.readCapped(res, controller)
      if (capped.kind === 'output_cap') {
        return { ok: false, kind: 'output_cap', error: 'response exceeded max_output_bytes' }
      }
      const raw = capped.text
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return { ok: false, kind: 'bad_response', error: 'response was not valid JSON' }
      }
      const result = webhookResponseSchema.safeParse(parsed)
      if (!result.success) {
        return { ok: false, kind: 'bad_response', error: 'response failed schema validation' }
      }
      return { ok: true, text: result.data.text.trim() }
    } catch (err) {
      const e = err as Error
      if (e.name === 'AbortError') {
        return { ok: false, kind: 'timeout', error: `timed out after ${this.cfg.timeout_ms}ms` }
      }
      return { ok: false, kind: 'transport', error: e.message }
    } finally {
      clearTimeout(timer)
    }
  }
}
