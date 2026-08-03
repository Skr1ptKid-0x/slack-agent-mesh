import { spawn } from 'node:child_process'
import type { CommandAdapterConfig } from '../config/schema.js'
import type { Adapter, AdapterRequest, AdapterResult } from './types.js'

/**
 * Runs an existing agent as a subprocess: the prompt is written to stdin and the
 * agent's stdout is the response. Enforces a hard timeout, an output byte cap,
 * and an explicit env allowlist (the child does NOT inherit the parent env, so
 * secrets never leak into an arbitrary command). Fails closed on every error.
 */
export class CommandAdapter implements Adapter {
  readonly kind = 'command' as const

  constructor(
    readonly name: string,
    private readonly cfg: CommandAdapterConfig,
    private readonly hostEnv: NodeJS.ProcessEnv = process.env,
    /** Injectable spawn for tests (e.g. simulating a synchronous throw). */
    private readonly spawnImpl: typeof spawn = spawn,
  ) {}

  private buildEnv(req: AdapterRequest): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const key of [...this.cfg.env_allowlist, ...this.cfg.env_pass]) {
      const val = this.hostEnv[key]
      if (val !== undefined) env[key] = val
    }
    // Non-secret turn metadata always available to the child.
    env.MESH_AGENT = req.agent
    env.MESH_TRACE_ID = req.trace.traceId
    env.MESH_HOP = String(req.trace.hop)
    env.MESH_CHANNEL = req.trace.channel
    env.MESH_THREAD_TS = req.trace.threadTs
    env.MESH_FROM = req.trace.from
    return env
  }

  invoke(req: AdapterRequest): Promise<AdapterResult> {
    const [exe, ...args] = this.cfg.command
    if (!exe) {
      return Promise.resolve({ ok: false, kind: 'misconfigured', error: 'empty command' })
    }
    const { timeout_ms, max_output_bytes } = this.cfg

    return new Promise<AdapterResult>((resolve) => {
      let settled = false
      // Declared before `finish` so a *synchronous* spawn throw (which calls
      // finish before the timer is armed) does not hit the temporal dead zone.
      // clearTimeout(undefined) is a safe no-op.
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (r: AdapterResult) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(r)
      }

      let child: ReturnType<typeof spawn>
      try {
        child = this.spawnImpl(exe, args, {
          cwd: this.cfg.cwd,
          env: this.buildEnv(req),
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (err) {
        finish({ ok: false, kind: 'transport', error: `spawn failed: ${(err as Error).message}` })
        return
      }

      timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish({ ok: false, kind: 'timeout', error: `timed out after ${timeout_ms}ms` })
      }, timeout_ms)

      const chunks: Buffer[] = []
      let total = 0
      let capped = false
      let stderrBytes = 0

      child.stdout?.on('data', (d: Buffer) => {
        total += d.length
        if (total > max_output_bytes) {
          capped = true
          child.kill('SIGKILL')
          finish({
            ok: false,
            kind: 'output_cap',
            error: `output exceeded ${max_output_bytes} bytes`,
          })
          return
        }
        chunks.push(d)
      })
      child.stderr?.on('data', (d: Buffer) => {
        // Drain stderr so the child cannot block, but never retain or surface its
        // contents: agent CLIs may print credentials or private tool output.
        stderrBytes += d.length
      })

      child.on('error', (err) => {
        finish({ ok: false, kind: 'transport', error: `process error: ${err.message}` })
      })

      child.on('close', (code) => {
        if (capped || settled) return
        if (code !== 0) {
          finish({
            ok: false,
            kind: 'nonzero_exit',
            error: `exit code ${code}; stderr suppressed (${stderrBytes} bytes)`,
          })
          return
        }
        const text = Buffer.concat(chunks).toString('utf8').trim()
        finish({ ok: true, text })
      })

      // Feed the prompt and close stdin.
      child.stdin?.on('error', () => {
        /* ignore EPIPE if the child exits early; close handler settles. */
      })
      child.stdin?.end(req.prompt)
    })
  }
}
