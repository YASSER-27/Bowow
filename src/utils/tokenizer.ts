interface ModelConfig {
  model?: string
  defaultCompletionOptions?: {
    contextLength?: number
    maxTokens?: number
  }
}

export interface ChatHistoryItem {
  message: {
    role: string
    content: string | any[]
    toolCalls?: Array<{ id: string; function: { name?: string; arguments?: string } }>
  }
  toolCallStates?: Array<{
    toolCall: { id: string; type: string; function: { name?: string; arguments?: string } }
    status?: string
    output?: Array<{ content?: string; name?: string }>
    parsedArgs?: any
  }>
  contextItems?: Array<{ content: string; name: string }>
  conversationSummary?: string
}

interface ToolDefinition {
  function: {
    name: string
    description?: string
    parameters?: { properties?: Record<string, { type?: string; description?: string; enum?: string[] }> }
  }
}

const DEFAULT_CONTEXT_LENGTH = 200_000
const DEFAULT_MAX_TOKENS_RATIO = 0.35
const MAX_MAX_TOKENS = 64_000

function getAdjustedTokenCount(count: number, _model?: string): number {
  return count
}

function encode(text: string): number[] {
  const tokens: number[] = []
  const words = text.match(/\S+\s*/g) || []
  for (const word of words) {
    const byteLen = new TextEncoder().encode(word).length
    const estimatedTokens = Math.max(1, Math.ceil(byteLen / 4))
    for (let i = 0; i < estimatedTokens; i++) tokens.push(0)
  }
  return tokens
}

export function countTokens(text: string): number {
  if (!text) return 0
  return encode(text).length
}

export function getModelContextLimit(model: ModelConfig): number {
  return model.defaultCompletionOptions?.contextLength ?? DEFAULT_CONTEXT_LENGTH
}

export function getModelMaxTokens(model: ModelConfig): number {
  const contextLimit = getModelContextLimit(model)
  const maxTokens = model.defaultCompletionOptions?.maxTokens
  return maxTokens === undefined
    ? Math.ceil(Math.min(contextLimit * DEFAULT_MAX_TOKENS_RATIO, MAX_MAX_TOKENS))
    : maxTokens
}

function countContentTokens(content: string | any[], model: ModelConfig): number {
  if (typeof content === 'string') {
    return getAdjustedTokenCount(encode(content).length, model.model)
  }
  if (Array.isArray(content)) {
    let count = 0
    for (const part of content) {
      if (part.type === 'text' && part.text) count += encode(part.text).length
      if (part.type === 'imageUrl') count += 1024
    }
    return getAdjustedTokenCount(count, model.model)
  }
  return 0
}

function countToolCallFunctionTokens(fn: { name?: string; arguments?: string } | undefined): number {
  if (!fn) return 0
  return encode(fn.name ?? '').length + 10 + encode(fn.arguments ?? '').length
}

function countToolOutputTokens(output: Array<{ content?: string; name?: string }> | undefined): number {
  if (!output) return 0
  let count = 0
  for (const item of output) {
    if (item.content) count += encode(item.content).length
    count += 5
  }
  return count
}

export function countChatHistoryItemTokens(item: ChatHistoryItem, model: ModelConfig): number {
  try {
    let total = 0
    total += countContentTokens(item.message.content, model)
    total += 2
    if (item.message.toolCalls && !item.toolCallStates) {
      for (const tc of item.message.toolCalls) {
        total += countToolCallFunctionTokens(tc.function)
      }
    }
    if (item.message.role === 'tool' && 'content' in item.message) total += 5
    for (const ctx of (item.contextItems || [])) {
      total += encode(ctx.content).length + encode(ctx.name).length + 5
    }
    if (item.toolCallStates) {
      for (const ts of item.toolCallStates) {
        total += countToolCallFunctionTokens(ts.toolCall?.function)
        total += countToolOutputTokens(ts.output)
      }
    }
    return total
  } catch {
    let contentStr = ''
    try {
      const content = item?.message?.content
      contentStr = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    } catch {}
    const contextContent = (item?.contextItems || []).map(c => c.content + c.name).join('')
    return Math.ceil((contentStr.length + contextContent.length) / 4)
  }
}

export function countChatHistoryTokens(history: ChatHistoryItem[], model: ModelConfig): number {
  let total = 0
  for (const item of history) total += countChatHistoryItemTokens(item, model)
  total += history.length * 3
  return total
}

export function calculateContextUsagePercentage(tokenCount: number, model: ModelConfig): number {
  return Math.min(100, Math.round((tokenCount / getModelContextLimit(model)) * 100))
}

function countSingleToolTokens(tool: ToolDefinition): number {
  let tokens = encode(tool.function.name).length
  if (tool.function.description) tokens += encode(tool.function.description).length
  const props = tool.function.parameters?.properties
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      tokens += encode(key).length + 2
      if (val.type && typeof val.type === 'string') tokens += 2 + encode(val.type).length
      if (val.description && typeof val.description === 'string') tokens += 2 + encode(val.description).length
    }
  }
  return tokens
}

export function countToolDefinitionTokens(tools: ToolDefinition[]): number {
  if (!tools?.length) return 0
  let tokens = 12
  for (const tool of tools) tokens += countSingleToolTokens(tool)
  return tokens + 12
}

export interface TotalInputTokenParams {
  chatHistory: ChatHistoryItem[]
  model: ModelConfig
  systemMessage?: string
  tools?: ToolDefinition[]
}

export function countTotalInputTokens(params: TotalInputTokenParams): number {
  const { chatHistory, systemMessage, tools, model } = params
  let total = countChatHistoryTokens(chatHistory, model)
  if (systemMessage) {
    const hasSystem = chatHistory.some(i => i.message.role === 'system')
    if (!hasSystem) total += encode(systemMessage).length + 4
  }
  if (tools?.length) total += countToolDefinitionTokens(tools)
  return total
}

export interface ValidateContextLengthParams {
  chatHistory: ChatHistoryItem[]
  model: ModelConfig
  safetyBuffer?: number
  systemMessage?: string
  tools?: ToolDefinition[]
}

export function validateContextLength(params: ValidateContextLengthParams): {
  isValid: boolean
  error?: string
  inputTokens?: number
  contextLimit?: number
  maxTokens?: number
} {
  const { chatHistory, model, safetyBuffer = 0, systemMessage, tools } = params
  const inputTokens = countTotalInputTokens({ chatHistory, systemMessage, tools, model })
  const contextLimit = getModelContextLimit(model)
  const maxTokens = model.defaultCompletionOptions?.maxTokens || 0
  const reservedForOutput = maxTokens > 0 ? maxTokens : Math.ceil(contextLimit * 0.35)
  const totalRequired = inputTokens + reservedForOutput + safetyBuffer

  if (totalRequired > contextLimit) {
    return {
      isValid: false,
      error: `Context length exceeded: input (${inputTokens.toLocaleString()}) + max_tokens (${reservedForOutput.toLocaleString()})${safetyBuffer > 0 ? ` + buffer (${safetyBuffer})` : ''} = ${totalRequired.toLocaleString()} > context_limit (${contextLimit.toLocaleString()})`,
      inputTokens, contextLimit, maxTokens: reservedForOutput,
    }
  }
  return { isValid: true, inputTokens, contextLimit, maxTokens: reservedForOutput }
}
