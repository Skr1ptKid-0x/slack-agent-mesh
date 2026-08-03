import type { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandAdapter } from '../../src/adapters/command.js'
import { MockAdapter } from '../../src/adapters/mock.js'
import type { AdapterRequest } from '../../src/adapters/types.js'
import { WebhookAdapter } from '../../src/adapters/webhook.js'
import { adapterSchema } from '../../src/config/schema.js'

const REQ: AdapterRequest = {
  agent: 'rook',
  prompt: 'hello',
  trace: { traceId: 't1', hop: 0, channel: 'C', threadTs: '1.0', from: 'U1' },
}

function cmd(cfg: Record<string, unknown>, env?: NodeJS.ProcessEnv) {
  const parsed = adapterSchema.parse({ type: 'command', ...cfg })
  if (parsed.type !== 'command') throw new Error('not command')
  return new CommandAdapter('rook', parsed, env)
}

describe('CommandAdapter', () => {
  it('returns stdout on success', async () => {
    const a = cmd({ command: [process.execPath, '-e', "process.stdout.write('hi from child')"] })
    const r = await a.invoke(REQ)
    expect(r).toEqual({ ok: true, text: 'hi from child' })
  })

  it('passes turn metadata via MESH_* env', async () => {
    const a = cmd({
      command: [
        process.execPath,
        '-e',
        'process.stdout.write(process.env.MESH_AGENT+process.env.MESH_HOP)',
      ],
    })
    const r = await a.invoke(REQ)
    expect(r.ok && r.text).toBe('rook0')
  })

  it('only forwards allowlisted env', async () => {
    const a = cmd(
      {
        command: [process.execPath, '-e', 'process.stdout.write(String(process.env.SECRET_X))'],
        env_allowlist: [],
      },
      { SECRET_X: 'leaked' },
    )
    const r = await a.invoke(REQ)
    expect(r.ok && r.text).toBe('undefined')
  })

  it('forwards an explicitly allowlisted env var', async () => {
    const a = cmd(
      {
        command: [process.execPath, '-e', 'process.stdout.write(String(process.env.ALLOWED))'],
        env_allowlist: ['ALLOWED'],
      },
      { ALLOWED: 'yes' },
    )
    const r = await a.invoke(REQ)
    expect(r.ok && r.text).toBe('yes')
  })

  it('fails closed on non-zero exit', async () => {
    const a = cmd({ command: [process.execPath, '-e', 'process.exit(3)'] })
    const r = await a.invoke(REQ)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('nonzero_exit')
  })

  it('never surfaces child stderr contents in adapter errors', async () => {
    const marker = 'private-child-stderr-value'
    const a = cmd({
      command: [process.execPath, '-e', `process.stderr.write('${marker}'); process.exit(7)`],
    })
    const r = await a.invoke(REQ)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe('nonzero_exit')
      expect(r.error).not.toContain(marker)
      expect(r.error).toContain('stderr suppressed')
    }
  })

  it('fails closed on timeout', async () => {
    const a = cmd({
      command: [process.execPath, '-e', 'setTimeout(()=>{}, 10000)'],
      timeout_ms: 200,
    })
    const r = await a.invoke(REQ)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('timeout')
  })

  it.skipIf(process.platform === 'win32')('kills descendant processes on timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-command-tree-'))
    const pidFile = join(dir, 'grandchild.pid')
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })",
      'writeFileSync(process.env.PID_FILE, String(child.pid))',
      'setInterval(()=>{},1000)',
    ].join(';')
    const a = cmd(
      {
        command: [process.execPath, '-e', script],
        timeout_ms: 250,
        env_allowlist: ['PID_FILE'],
      },
      { PID_FILE: pidFile },
    )

    let grandchildPid = 0
    try {
      const r = await a.invoke(REQ)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.kind).toBe('timeout')
      grandchildPid = Number(readFileSync(pidFile, 'utf8'))

      let alive = true
      for (let i = 0; i < 40 && alive; i += 1) {
        try {
          process.kill(grandchildPid, 0)
          await new Promise((resolve) => setTimeout(resolve, 25))
        } catch {
          alive = false
        }
      }
      expect(alive).toBe(false)
    } finally {
      if (grandchildPid > 0) {
        try {
          process.kill(grandchildPid, 'SIGKILL')
        } catch {
          // Already terminated, which is the expected path.
        }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when output exceeds the cap', async () => {
    const a = cmd({
      command: [process.execPath, '-e', "process.stdout.write('x'.repeat(5000))"],
      max_output_bytes: 100,
    })
    const r = await a.invoke(REQ)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('output_cap')
  })

  it('fails closed (transport) when spawn throws synchronously', async () => {
    // Some spawn failures (e.g. EACCES on a non-executable path) throw straight
    // out of spawn() rather than emitting an async 'error' event. The adapter
    // must catch that and settle once, not leak the throw or hang the promise.
    const throwingSpawn = (() => {
      throw new Error('EACCES: permission denied')
    }) as unknown as typeof spawn
    const parsed = adapterSchema.parse({ type: 'command', command: ['/not/executable'] })
    if (parsed.type !== 'command') throw new Error('not command')
    const a = new CommandAdapter('rook', parsed, {}, throwingSpawn)
    const r = await a.invoke(REQ)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.kind).toBe('transport')
      expect(r.error).toContain('spawn failed')
    }
  })
})

describe('WebhookAdapter', () => {
  it('signs and verifies symmetrically', () => {
    const sig = WebhookAdapter.sign('secret', '123', 'body')
    expect(WebhookAdapter.verify('secret', '123', 'body', sig)).toBe(true)
    expect(WebhookAdapter.verify('secret', '123', 'tampered', sig)).toBe(false)
  })

  function hook(cfg: Record<string, unknown>, env: NodeJS.ProcessEnv, fetchImpl: typeof fetch) {
    const parsed = adapterSchema.parse({
      type: 'webhook',
      url_env: 'HOOK_URL',
      secret_env: 'HOOK_SECRET',
      ...cfg,
    })
    if (parsed.type !== 'webhook') throw new Error('not webhook')
    return new WebhookAdapter(
      'scout',
      parsed,
      { HOOK_SECRET: 'test-signing-secret', ...env },
      fetchImpl,
      () => 1_000_000,
    )
  }

  it('returns text on a valid signed response', async () => {
    let captured: RequestInit | undefined
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured = init
      return new Response(JSON.stringify({ text: 'remote reply' }), { status: 200 })
    }) as unknown as typeof fetch
    const a = hook(
      { secret_env: 'HOOK_SECRET' },
      { HOOK_URL: 'https://x', HOOK_SECRET: 's' },
      fetchImpl,
    )
    const r = await a.invoke(REQ)
    expect(r).toEqual({ ok: true, text: 'remote reply' })
    const headers = captured?.headers as Record<string, string>
    expect(headers['x-mesh-signature']).toMatch(/^v0=/)
  })

  it('is misconfigured when the url env is missing', async () => {
    const a = hook({}, {}, (async () => new Response('')) as unknown as typeof fetch)
    const r = await a.invoke(REQ)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('misconfigured')
  })

  it('fails closed instead of sending an unsigned request when the secret env is missing', async () => {
    const parsed = adapterSchema.parse({
      type: 'webhook',
      url_env: 'HOOK_URL',
      secret_env: 'HOOK_SECRET',
    })
    if (parsed.type !== 'webhook') throw new Error('not webhook')
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response(JSON.stringify({ text: 'must not run' }))
    }) as unknown as typeof fetch
    const a = new WebhookAdapter('scout', parsed, { HOOK_URL: 'https://x' }, fetchImpl)
    const r = await a.invoke(REQ)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('misconfigured')
    expect(called).toBe(false)
  })

  it('fails closed on a malformed (schema-invalid) response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ wrong: 1 }), { status: 200 })) as unknown as typeof fetch
    const a = hook({}, { HOOK_URL: 'https://x' }, fetchImpl)
    const r = await a.invoke(REQ)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('bad_response')
  })

  it('fails closed on a non-2xx status', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    const a = hook({}, { HOOK_URL: 'https://x' }, fetchImpl)
    const r = await a.invoke(REQ)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('transport')
  })

  it('aborts a streamed over-cap response before consuming the whole stream', async () => {
    // A hostile/runaway remote must be cut off the instant its streamed body
    // crosses the cap — not buffered in full first. We prove that by making the
    // stream effectively unbounded (it only self-closes after 1000 pulls) and
    // asserting the adapter cancelled it and aborted the request far earlier.
    let pulls = 0
    let cancelled = false
    let aborted = false
    const CHUNK = new Uint8Array(60) // 60 bytes/pull; cap is 100 => trips on pull 2
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls > 1000) {
          controller.close()
          return
        }
        controller.enqueue(CHUNK)
      },
      cancel() {
        cancelled = true
      },
    })
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        aborted = true
      })
      return new Response(stream, { status: 200 })
    }) as unknown as typeof fetch
    const a = hook({ max_output_bytes: 100 }, { HOOK_URL: 'https://x' }, fetchImpl)
    const r = await a.invoke(REQ)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('output_cap')
    expect(cancelled).toBe(true) // reader.cancel() ran
    expect(aborted).toBe(true) // controller.abort() signalled the request
    expect(pulls).toBeLessThan(50) // nowhere near draining the full stream
  })

  it('fails closed on an aborted (timeout) request', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted')
          e.name = 'AbortError'
          reject(e)
        })
      })
    }) as unknown as typeof fetch
    const a = hook({ timeout_ms: 100 }, { HOOK_URL: 'https://x' }, fetchImpl)
    const r = await a.invoke(REQ)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.kind).toBe('timeout')
  })
})

describe('MockAdapter', () => {
  it('returns the default reply', async () => {
    const a = new MockAdapter('rook', { type: 'mock', reply: 'default', replies: [], delay_ms: 0 })
    const r = await a.invoke(REQ)
    expect(r.ok && r.text).toBe('default')
  })

  it('matches a substring rule', async () => {
    const a = new MockAdapter('rook', {
      type: 'mock',
      reply: 'default',
      replies: [{ when_prompt_contains: 'HELLO', reply: 'matched' }],
      delay_ms: 0,
    })
    const r = await a.invoke(REQ)
    expect(r.ok && r.text).toBe('matched')
  })
})
