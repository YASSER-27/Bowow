import { countTotalInputTokens, countChatHistoryTokens, countToolDefinitionTokens, getModelContextLimit, getModelMaxTokens, countTokens } from './tokenizer'

interface ModelConfig {
  model?: string
  defaultCompletionOptions?: {
    contextLength?: number
    maxTokens?: number
  }
}

interface HistoryItem {
  message: {
    role: string
    content: string | any[]
    toolCalls?: Array<{ id: string; function: { name?: string; arguments?: string } }>
  }
  toolCallStates?: Array<{
    toolCall: { id: string; type: string; function: { name?: string; arguments?: string } }
    status?: string
    output?: Array<{ content?: string; name?: string }>
  }>
  contextItems?: Array<{ content: string; name: string }>
  conversationSummary?: string
}

// ── Constants ─────────────────────────────────────────────────────
const AUTO_COMPACT_BUFFER_CAP = 15_000
const AUTO_COMPACT_BUFFER_RATIO = 0.8
const COMPACTION_PROMPT = 'Please provide a concise summary of our conversation so far, capturing the key context, decisions made, and current state. Format this as a single comprehensive message that preserves all important information needed to continue our work. You do not need to recap the system message, as this will remain. Make sure it is clear what the current stream of work was at the very end prior to compaction so that you can continue exactly where you left off without missing any information.'
const COMPACTION_PROMPT_TOKENS = 150

// ── Prune Last Message ────────────────────────────────────────────
export function pruneLastMessage(history: HistoryItem[]): HistoryItem[] {
  if (history.length === 0) return history
  if (history.length === 1) return []
  const secondLast = history[history.length - 2]
  if (secondLast.message.role === 'assistant' && (secondLast.message as any).toolCalls?.length > 0) {
    return history.slice(0, -2)
  }
  if (secondLast.message.role === 'user') return history.slice(0, -2)
  return history.slice(0, -1)
}

// ── Find Compaction Index ─────────────────────────────────────────
export function findCompactionIndex(history: HistoryItem[]): number | null {
  const idx = history.findIndex(item => item.conversationSummary !== undefined)
  return idx === -1 ? null : idx
}

// ── Get History for LLM ───────────────────────────────────────────
export function getHistoryForLLM(
  fullHistory: HistoryItem[],
  compactionIndex: number | null,
): HistoryItem[] {
  if (compactionIndex === null || compactionIndex >= fullHistory.length) return fullHistory
  const systemMsg = fullHistory[0]?.message?.role === 'system' ? fullHistory[0] : null
  const messagesFromCompaction = fullHistory.slice(compactionIndex)
  return systemMsg && compactionIndex > 0
    ? [systemMsg, ...messagesFromCompaction]
    : messagesFromCompaction
}

// ── Should Auto-Compact ───────────────────────────────────────────
export interface AutoCompactParams {
  history: HistoryItem[]
  model: ModelConfig
  systemMessage?: string
  tools?: any[]
}

export function shouldAutoCompact(params: AutoCompactParams): boolean {
  const { history, model, systemMessage, tools } = params

  const inputTokens = countTotalInputTokens({
    chatHistory: history as any,
    systemMessage,
    tools,
    model: model as any,
  })
  const contextLimit = getModelContextLimit(model as any)
  const maxTokens = getModelMaxTokens(model as any)

  const ratioBuffer = Math.ceil((1 - AUTO_COMPACT_BUFFER_RATIO) * (contextLimit - maxTokens))
  const safeBuffer = Math.max(maxTokens, ratioBuffer)
  const compactionBuffer = Math.min(safeBuffer, AUTO_COMPACT_BUFFER_CAP)
  const compactionThreshold = contextLimit - maxTokens - compactionBuffer

  if (compactionThreshold <= 0) {
    throw new Error('max_tokens is larger than context_length. Please check your configuration.')
  }

  const toolTokens = tools ? countToolDefinitionTokens(tools) : 0
  const systemTokens = systemMessage ? countTokens(systemMessage) : 0
  const shouldCompact = inputTokens >= compactionThreshold

  return shouldCompact
}

// ── Autocompact Message ───────────────────────────────────────────
export function getAutoCompactMessage(model: ModelConfig): string {
  const limit = getModelContextLimit(model as any)
  return `Approaching context limit (${(limit / 1000).toFixed(0)}K tokens). Auto-compacting chat history...`
}

// ── Compact Chat History ──────────────────────────────────────────
export interface CompactionResult {
  compactedHistory: HistoryItem[]
  compactionIndex: number
  compactionContent: string
}

export interface CompactionCallbacks {
  onStreamContent?: (content: string) => void
  onStreamComplete?: () => void
  onError?: (error: Error) => void
}

export async function compactChatHistory(
  history: HistoryItem[],
  model: ModelConfig,
  llmApi: (messages: any[], signal: AbortSignal) => AsyncGenerator<string>,
  options?: {
    callbacks?: CompactionCallbacks
    abortController?: AbortController
    systemMessageTokens?: number
  },
): Promise<CompactionResult> {
  const { callbacks, abortController, systemMessageTokens = 0 } = options || {}

  const compactionPrompt: HistoryItem = {
    message: { role: 'user', content: COMPACTION_PROMPT },
    contextItems: [],
  }

  let historyToUse = [...history]
  let historyForCompaction = [...historyToUse, compactionPrompt]
  const contextLimit = getModelContextLimit(model as any)
  const maxTokens = getModelMaxTokens(model as any)
  const hasSystemInHistory = history.some(item => item.message.role === 'system')
  const systemReservation = hasSystemInHistory ? 0 : systemMessageTokens
  const availableForInput = contextLimit - maxTokens - systemReservation - COMPACTION_PROMPT_TOKENS

  while (
    countChatHistoryTokens(historyForCompaction as any, model as any) > availableForInput &&
    historyToUse.length > 0
  ) {
    const pruned = pruneLastMessage(historyToUse)
    if (pruned.length === historyToUse.length) break
    historyToUse = pruned
    historyForCompaction = [...historyToUse, compactionPrompt]
  }

  const controller = abortController || new AbortController()
  let compactionContent = ''

  try {
    for await (const chunk of llmApi(historyForCompaction.map(h => ({
      role: h.message.role,
      content: typeof h.message.content === 'string' ? h.message.content : JSON.stringify(h.message.content),
    })), controller.signal)) {
      compactionContent += chunk
      callbacks?.onStreamContent?.(chunk)
    }
    callbacks?.onStreamComplete?.()

    const systemMessage = history.find(item => item.message.role === 'system')
    const compactionMessage: HistoryItem = {
      message: { role: 'assistant', content: compactionContent },
      contextItems: [],
      conversationSummary: compactionContent,
    }
    const compactedHistory = systemMessage
      ? [systemMessage, compactionMessage]
      : [compactionMessage]

    return {
      compactedHistory,
      compactionContent,
      compactionIndex: systemMessage ? 1 : 0,
    }
  } catch (error) {
    callbacks?.onError?.(error as Error)
    throw error
  }
}
