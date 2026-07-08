import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  evaluate, wildcardMatch, denied, assert, reply, setConfiguredRules,
  setSavedRules, PermissionBlockedError, PermissionDeclinedError,
} from './permission'

// Mock window for CustomEvent dispatch
vi.stubGlobal('window', {
  dispatchEvent: vi.fn(),
})

beforeEach(() => {
  setConfiguredRules([])
  setSavedRules([])
})

describe('wildcardMatch', () => {
  it('exact match', () => expect(wildcardMatch('edit', 'edit')).toBe(true))
  it('star matches all', () => expect(wildcardMatch('*', 'anything')).toBe(true))
  it('prefix wildcard', () => expect(wildcardMatch('*.txt', 'foo.txt')).toBe(true))
  it('suffix wildcard', () => expect(wildcardMatch('read_*', 'read_file')).toBe(true))
  it('no match', () => expect(wildcardMatch('read', 'edit')).toBe(false))
})

describe('evaluate', () => {
  it('returns allow for matching allow rule', () => {
    const rule = evaluate('edit', 'src/*', [{ action: 'edit', resource: 'src/*', effect: 'allow' }])
    expect(rule.effect).toBe('allow')
  })
  it('returns deny for matching deny rule', () => {
    const rule = evaluate('run_command', '*', [{ action: 'run_command', resource: '*', effect: 'deny' }])
    expect(rule.effect).toBe('deny')
  })
  it('returns ask when no rule matches', () => {
    const rule = evaluate('edit', 'src/main.ts', [])
    expect(rule.effect).toBe('ask')
  })
})

describe('denied', () => {
  it('returns true when any resource is denied', () => {
    const rules = [{ action: 'edit', resource: 'secret/*', effect: 'deny' as const }]
    expect(denied({ action: 'edit', sessionID: 's1', resources: ['secret/key'] }, rules)).toBe(true)
  })
  it('returns false when no resource is denied', () => {
    expect(denied({ action: 'edit', sessionID: 's1', resources: ['public/file'] }, [])).toBe(false)
  })
})

describe('assert', () => {
  it('resolves immediately when effect is allow', async () => {
    setConfiguredRules([{ action: 'read', resource: '*', effect: 'allow' }])
    await expect(assert({ action: 'read', sessionID: 's1', resources: ['file.txt'] })).resolves.toBeUndefined()
  })

  it('rejects with PermissionBlockedError when denied', async () => {
    setConfiguredRules([{ action: 'write', resource: '*', effect: 'deny' }])
    await expect(assert({ action: 'write', sessionID: 's1', resources: ['file.txt'] })).rejects.toThrow(PermissionBlockedError)
  })

  it('dispatches permission-request event when ask', async () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent')
    const promise = assert({ action: 'edit', sessionID: 's1', resources: ['file.txt'] })
    await vi.waitFor(() => expect(dispatchSpy).toHaveBeenCalled())
    const event = dispatchSpy.mock.calls[0][0] as CustomEvent
    expect(event.type).toBe('permission-request')
    expect(event.detail.resources).toEqual(['file.txt'])
    reply({ requestID: event.detail.id, reply: 'allow' })
    await expect(promise).resolves.toBeUndefined()
  })
})
