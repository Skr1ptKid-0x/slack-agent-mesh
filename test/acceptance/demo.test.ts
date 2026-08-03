import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runDemo } from '../../src/demo/demo.js'

const scriptPath = fileURLToPath(new URL('../../examples/demo-conversation.json', import.meta.url))

describe('credential-free demo (clean-install gate)', () => {
  it('prints a deterministic human -> rook -> scout transcript and a trace receipt', async () => {
    const a = await runDemo(scriptPath)
    const b = await runDemo(scriptPath)
    // Deterministic across runs (modulo the monotonically increasing trace id).
    expect(a.lines.map(stripTraceId)).toEqual(b.lines.map(stripTraceId))

    expect(a.transcript).toContain('[human U_HUMAN]')
    expect(a.transcript).toContain('*@rook*')
    expect(a.transcript).toContain('*@scout*')
    expect(a.transcript).toContain('--- trace receipts ---')

    const receiptLine = a.lines.find((l) => l.includes('"visited"'))
    expect(receiptLine).toBeDefined()
    const receipt = JSON.parse(receiptLine as string)
    expect(receipt.visited).toEqual(['rook', 'scout'])
    expect(receipt.hops).toBe(1)
    expect(receipt.messages).toBe(2)
  })
})

function stripTraceId(line: string): string {
  return line.replace(/trc_demo_\d+/g, 'trc_demo_N')
}
