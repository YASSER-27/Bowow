/** Permission system adapted from opencode's PermissionV2 */

export type PermissionEffect = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  action: string
  resource: string
  effect: PermissionEffect
}

export type PermissionRuleset = PermissionRule[]

export interface PermissionSource {
  type: 'tool'
  messageID: string
  callID: string
}

export interface PermissionRequest {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, any>
  source?: PermissionSource
}

export interface AssertInput {
  id?: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, any>
  source?: PermissionSource
  agent?: string
}

export class PermissionBlockedError extends Error {
  constructor(readonly rules: PermissionRule[]) {
    super('Permission blocked by rules')
  }
}

export class PermissionDeclinedError extends Error {
  constructor() {
    super('Permission declined by user')
  }
}

export class PermissionCorrectedError extends Error {
  constructor(readonly feedback: string) {
    super(`Permission corrected: ${feedback}`)
  }
}

let idCounter = 0
function nextID(): string {
  return `perm_${++idCounter}_${Date.now()}`
}

export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true
  if (pattern === '*') return true
  const parts = pattern.split('*')
  if (parts.length === 2 && parts[0] === '') return value.endsWith(parts[1])
  if (parts.length === 2 && parts[1] === '') return value.startsWith(parts[0])
  return false
}

export function evaluate(action: string, resource: string, ...rulesets: PermissionRuleset[]): PermissionRule {
  for (const ruleset of rulesets) {
    const rule = [...ruleset].reverse().find(r => wildcardMatch(r.action, action) && wildcardMatch(r.resource, resource))
    if (rule) return rule
  }
  return { action, resource: '*', effect: 'ask' }
}

export function merge(...rulesets: PermissionRuleset[]): PermissionRuleset {
  return rulesets.flat()
}

/** Pending permission requests awaiting user reply. */
const pendingRequests = new Map<string, PendingRequest>()

interface PendingRequest {
  request: PermissionRequest
  agent?: string
  resolve: (value: void) => void
  reject: (err: Error) => void
}

const configuredRules: PermissionRuleset = []
let savedRules: PermissionRuleset = []

export function setConfiguredRules(rules: PermissionRuleset) {
  configuredRules.length = 0
  configuredRules.push(...rules)
}

export function setSavedRules(rules: PermissionRule[]) {
  savedRules = rules
}

export function denied(input: AssertInput, rules: PermissionRuleset): boolean {
  return input.resources.some(resource => evaluate(input.action, resource, rules).effect === 'deny')
}

async function evaluateInput(input: AssertInput) {
  if (denied(input, configuredRules)) return { effect: 'deny' as const, rules: configuredRules }
  const all = merge(configuredRules, savedRules)
  const effects = input.resources.map(resource => evaluate(input.action, resource, all).effect)
  const effect: PermissionEffect = effects.includes('deny') ? 'deny' : effects.includes('ask') ? 'ask' : 'allow'
  return { effect, rules: all }
}

function makeRequest(input: AssertInput): PermissionRequest {
  return {
    id: input.id ?? nextID(),
    sessionID: input.sessionID,
    action: input.action,
    resources: input.resources,
    save: input.save,
    metadata: input.metadata,
    source: input.source,
  }
}

export function ask(input: AssertInput): Promise<{ id: string; effect: PermissionEffect }> {
  return new Promise(async (resolve, reject) => {
    const result = await evaluateInput(input)
    const request = makeRequest(input)
    if (result.effect === 'ask') {
      pendingRequests.set(request.id, { request, agent: input.agent, resolve, reject: reject as any })
      window.dispatchEvent(new CustomEvent('permission-request', { detail: request }))
    }
    resolve({ id: request.id, effect: result.effect })
  })
}

export function assert(input: AssertInput): Promise<void> {
  return new Promise(async (resolve, reject) => {
    const result = await evaluateInput(input)
    if (result.effect === 'deny') {
      return reject(new PermissionBlockedError(result.rules))
    }
    if (result.effect === 'allow') return resolve()
    const request = makeRequest(input)
    pendingRequests.set(request.id, { request, agent: input.agent, resolve, reject })
    window.dispatchEvent(new CustomEvent('permission-request', { detail: request }))
  })
}

export interface ReplyInput {
  requestID: string
  reply: 'allow' | 'reject' | 'always'
  message?: string
}

export function reply(input: ReplyInput) {
  const existing = pendingRequests.get(input.requestID)
  if (!existing) return

  if (input.reply === 'reject') {
    existing.reject(input.message ? new PermissionCorrectedError(input.message) : new PermissionDeclinedError())
    pendingRequests.delete(input.requestID)
    for (const [id, item] of pendingRequests) {
      if (item.request.sessionID !== existing.request.sessionID) continue
      item.reject(new PermissionDeclinedError())
      pendingRequests.delete(id)
    }
    return
  }

  if (input.reply === 'always' && existing.request.save?.length) {
    for (const resource of existing.request.save) {
      savedRules.push({ action: existing.request.action, resource, effect: 'allow' })
    }
  }

  existing.resolve()
  pendingRequests.delete(input.requestID)

  if (input.reply === 'always') {
    for (const [id, item] of pendingRequests) {
      if (item.request.sessionID !== existing.request.sessionID) continue
      const all = merge(configuredRules, savedRules)
      if (item.request.resources.every(r => evaluate(item.request.action, r, all).effect === 'allow')) {
        item.resolve()
        pendingRequests.delete(id)
      }
    }
  }
}

export function listPending(): PermissionRequest[] {
  return Array.from(pendingRequests.values(), item => item.request)
}

export function getPending(id: string): PermissionRequest | undefined {
  return pendingRequests.get(id)?.request
}

export function forSession(sessionID: string): PermissionRequest[] {
  return Array.from(pendingRequests.values(), item => item.request).filter(r => r.sessionID === sessionID)
}
