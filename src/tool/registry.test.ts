import { describe, it, expect, beforeEach } from 'vitest'
import { registerBuiltins } from './builtins'
import { toolRegistry } from './registry'

beforeEach(() => {
  registerBuiltins()
})

describe('toolRegistry.materialize().settle', () => {
  it('returns error for unknown tool', async () => {
    const m = toolRegistry.materialize()
    const result = await m.settle({
      sessionID: 'test',
      agent: 'default',
      assistantMessageID: 'msg1',
      call: { id: 'c1', name: 'unknown_tool', input: {} },
    })
    expect(result.result.type).toBe('error')
    expect(result.result.value).toContain('Unknown tool')
  })
})
