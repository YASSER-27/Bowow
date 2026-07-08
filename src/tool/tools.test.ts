import { describe, it, expect, beforeEach } from 'vitest'
import { registerBuiltins, toolRegistry } from './builtins'

beforeEach(() => {
  registerBuiltins()
})

describe('toolRegistry', () => {
  it('has definitions for all built-in tools', () => {
    const defs = toolRegistry.toToolDefs()
    const names = defs.map(d => d.function.name)
    expect(names).toContain('read_file')
    expect(names).toContain('edit_file')
    expect(names).toContain('create_file')
    expect(names).toContain('run_command')
    expect(names).toContain('glob_search')
    expect(names).toContain('grep_search')
    expect(names).toContain('task')
  })

  it('each definition has name, description, and parameters', () => {
    const defs = toolRegistry.toToolDefs()
    for (const d of defs) {
      expect(d.function.name).toBeTruthy()
      expect(d.function.description).toBeTruthy()
      expect(d.function.parameters).toBeTruthy()
      expect(d.function.parameters.type).toBe('object')
    }
  })
})
