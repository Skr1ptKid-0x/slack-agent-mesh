import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runDoctor } from '../../src/doctor.js'

const temps: string[] = []

function configFor(command: string, cwd?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-doctor-'))
  temps.push(dir)
  const path = join(dir, 'mesh.config.yaml')
  const cwdLine = cwd ? `\n      cwd: ${JSON.stringify(cwd)}` : ''
  writeFileSync(
    path,
    `mesh:\n  state_path: ':memory:'\nagents:\n  - name: worker\n    adapter:\n      type: command\n      command: [${JSON.stringify(command)}]${cwdLine}\n`,
  )
  return path
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('doctor command preflight', () => {
  it('passes a runnable absolute executable', () => {
    const report = runDoctor(configFor(process.execPath), process.env)
    expect(report.ok).toBe(true)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: '@worker command', status: 'ok' }),
    )
  })

  it('fails when the configured executable cannot be resolved', () => {
    const report = runDoctor(configFor('definitely-not-a-real-agent-cli'), {
      ...process.env,
      PATH: '',
    })
    expect(report.ok).toBe(false)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: '@worker command', status: 'fail' }),
    )
  })

  it('fails when the configured working directory does not exist', () => {
    const report = runDoctor(
      configFor(process.execPath, '/definitely/missing/mesh-cwd'),
      process.env,
    )
    expect(report.ok).toBe(false)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: '@worker cwd', status: 'fail' }),
    )
  })
})

describe('doctor allowlist preflight', () => {
  it('warns that empty allowlists reject every message', () => {
    const report = runDoctor(configFor(process.execPath), process.env)
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: 'allowed users', status: 'warn' }),
    )
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: 'allowed channels', status: 'warn' }),
    )
  })
})
