import type { MockAdapterConfig } from '../config/schema.js'
import type { Adapter, AdapterRequest, AdapterResult } from './types.js'

/**
 * Deterministic adapter for the demo and tests. Given a prompt, it returns the
 * first rule whose `when_prompt_contains` substring matches, else the default
 * reply. No network, no clock dependence, fully reproducible.
 */
export class MockAdapter implements Adapter {
  readonly kind = 'mock' as const

  constructor(
    readonly name: string,
    private readonly cfg: MockAdapterConfig,
  ) {}

  private pick(prompt: string): string {
    const lc = prompt.toLowerCase()
    for (const rule of this.cfg.replies) {
      if (!rule.when_prompt_contains || lc.includes(rule.when_prompt_contains.toLowerCase())) {
        return rule.reply
      }
    }
    return this.cfg.reply
  }

  async invoke(req: AdapterRequest): Promise<AdapterResult> {
    if (this.cfg.delay_ms > 0) {
      await new Promise((r) => setTimeout(r, this.cfg.delay_ms))
    }
    const text = this.pick(req.prompt).trim()
    return { ok: true, text }
  }
}
