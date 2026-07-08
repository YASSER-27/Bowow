export interface ToolCall {
  id: string
  name: string
  input: Record<string, any>
}

export interface ToolContext {
  sessionID: string
  agent: string
  assistantMessageID: string
  toolCallID: string
  buildId?: number
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, any>
}

export interface ToolOutput {
  structured: any
  content: { type: 'text' | 'file'; text?: string; data?: string; mime?: string; name?: string }[]
}

export class ToolFailure {
  constructor(readonly message: string) {}
}

type Config<Input, Output> = {
  description: string
  validate: (input: any) => input is Input
  inputSchema: Record<string, any>
  execute: (input: Input, context: ToolContext) => Promise<Output>
  toModelOutput?: (input: Input, output: Output) => string
}

type Runtime = {
  permission?: string
  definition: (name: string) => ToolDefinition
  settle: (call: ToolCall, context: ToolContext) => Promise<ToolOutput>
}

const runtimes = new WeakMap<object, Runtime>()

export type AnyTool = object

export function make<Input, Output>(config: Config<Input, Output>): AnyTool {
  const tool = Object.freeze({})
  const definitions = new Map<string, ToolDefinition>()
  runtimes.set(tool, {
    definition: (name) => {
      const cached = definitions.get(name)
      if (cached) return cached
      const definition: ToolDefinition = { name, description: config.description, inputSchema: config.inputSchema }
      definitions.set(name, definition)
      return definition
    },
    settle: async (call, context) => {
      if (!config.validate(call.input)) {
        throw new ToolFailure(`Invalid tool input for ${call.name}: ${JSON.stringify(call.input)}`)
      }
      const input = call.input as Input
      const output = await config.execute(input, context)
      const content = config.toModelOutput
        ? [{ type: 'text' as const, text: config.toModelOutput(input, output) }]
        : [{ type: 'text' as const, text: typeof output === 'string' ? output : JSON.stringify(output) }]
      return { structured: output, content }
    },
  })
  return tool
}

export function withPermission(tool: AnyTool, permission: string): AnyTool {
  const decorated = Object.freeze({})
  runtimes.set(decorated, { ...runtimeOf(tool), permission })
  return decorated
}

export const permission = (tool: AnyTool, name: string) => runtimeOf(tool).permission ?? name
export const definition = (name: string, tool: AnyTool) => runtimeOf(tool).definition(name)
export const settle = (tool: AnyTool, call: ToolCall, context: ToolContext) => runtimeOf(tool).settle(call, context)

function runtimeOf(tool: AnyTool): Runtime {
  const runtime = runtimes.get(tool)
  if (!runtime) throw new TypeError('Invalid tool value')
  return runtime
}

export function validateName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw new Error(`Invalid tool name: ${name}`)
  }
}
