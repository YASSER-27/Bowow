import { applicationTools } from './application-tools'
import { Tools } from './tools'
import { definition, permission, settle, validateName, type AnyTool, type ToolCall, type ToolContext, type ToolDefinition } from './tool'
import type { PermissionRuleset } from '../permission/permission'
import { wildcardMatch } from '../permission/permission'

export interface ExecuteInput {
  sessionID: string
  agent: string
  assistantMessageID: string
  call: ToolCall
  context?: Partial<ToolContext>
}

export interface Settlement {
  result: { type: 'success' | 'error'; value: any }
  output?: { structured: any; content: { type: 'text' | 'file'; text?: string }[] }
}

export interface Materialization {
  definitions: ToolDefinition[]
  settle: (input: ExecuteInput) => Promise<Settlement>
}

interface Registration {
  identity: object
  tool: AnyTool
}

export class ToolRegistry {
  private local = new Map<string, Registration[]>()
  private tokenCounter = 0

  constructor() {
    Tools.init((tools) => this.register(tools))
  }

  register(tools: Record<string, AnyTool>): void {
    for (const name of Object.keys(tools)) validateName(name)
    const token = ++this.tokenCounter
    for (const [name, tool] of Object.entries(tools)) {
      const registrations = this.local.get(name) ?? []
      registrations.push({ token, identity: {}, tool })
      this.local.set(name, registrations)
    }
  }

  /** Get all registered definitions as OpenAI-style tool definitions */
  toToolDefs(): Record<string, any>[] {
    const materialization = this.materialize()
    return materialization.definitions.map(d => ({
      type: 'function',
      function: {
        name: d.name,
        description: d.description,
        parameters: d.inputSchema,
      },
    }))
  }

  materialize(permissions?: PermissionRuleset): Materialization {
    const registrations = new Map<string, Registration>(applicationTools.getEntries())
    for (const [name, entries] of this.local) {
      const last = entries[entries.length - 1]
      if (last) registrations.set(name, last)
    }
    for (const [name, reg] of registrations) {
      const action = permission(reg.tool, name)
      if (whollyDisabled(action, permissions ?? [])) {
        registrations.delete(name)
      }
    }
    return {
      definitions: Array.from(registrations, ([name, reg]) => definition(name, reg.tool)),
      settle: async (input) => {
        const reg = registrations.get(input.call.name)
        if (!reg) return { result: { type: 'error', value: `Unknown tool: ${input.call.name}` } }
        try {
          const output = await settle(reg.tool, input.call, {
            sessionID: input.sessionID,
            agent: input.agent,
            assistantMessageID: input.assistantMessageID,
            toolCallID: input.call.id,
            ...input.context,
          })
          return { result: { type: 'success', value: output.structured }, output }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return { result: { type: 'error', value: message } }
        }
      },
    }
  }
}

function whollyDisabled(action: string, rules: PermissionRuleset): boolean {
  const rule = [...rules].reverse().find(r => wildcardMatch(action, r.action))
  return rule?.resource === '*' && rule.effect === 'deny'
}

export const toolRegistry = new ToolRegistry()
