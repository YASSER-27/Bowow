export interface CompactionResult {
  summary: string | undefined
  prunedMessages: number
  preservedMessages: number
}

const PRUNE_MINIMUM = 20_000
const PRUNE_PROTECT = 40_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const MIN_PRESERVE_RECENT_TOKENS = 2_000
const MAX_PRESERVE_RECENT_TOKENS = 8_000

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  tokenCount?: number
  type?: string
}

const estimateTokens = (text: string): number => Math.round(text.length / 4)

export const compact = (messages: Message[], summarize: (msgs: Message[]) => Promise<string>): Promise<CompactionResult> =>
  compactWithHeader(messages, '', summarize)

export const compactWithHeader = async (
  messages: Message[],
  systemHeader: string,
  summarize: (msgs: Message[]) => Promise<string>,
): Promise<CompactionResult> => {
  if (messages.length < 4) return { summary: undefined, prunedMessages: 0, preservedMessages: messages.length }

  const totalTokens = messages.reduce((s, m) => s + (m.tokenCount ?? estimateTokens(m.content)), 0)

  if (totalTokens < PRUNE_MINIMUM) return { summary: undefined, prunedMessages: 0, preservedMessages: messages.length }

  // Protect recent messages
  let protectedTokens = 0
  let protectCount = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const tokens = messages[i].tokenCount ?? estimateTokens(messages[i].content)
    protectedTokens += tokens
    protectCount++
    if (protectedTokens >= MIN_PRESERVE_RECENT_TOKENS && protectedTokens >= MAX_PRESERVE_RECENT_TOKENS) break
  }

  // Messages to summarize: everything before the protected tail
  const toSummarize = messages.slice(0, messages.length - protectCount)
  if (toSummarize.length < 2) return { summary: undefined, prunedMessages: 0, preservedMessages: messages.length }

  const summary = await summarize(toSummarize)

  return {
    summary,
    prunedMessages: toSummarize.length,
    preservedMessages: protectCount,
  }
}

export const truncateToolOutput = (content: string, maxChars: number = TOOL_OUTPUT_MAX_CHARS): string => {
  if (content.length <= maxChars) return content
  return content.slice(0, maxChars) + '\n... [tool output truncated]'
}

export const buildCompactionPrompt = (messages: Message[], summary: string): Message[] => {
  return [
    { id: 'system-summary', role: 'system', content: `Previous conversation context:\n${summary}` },
    ...messages.slice(-4),
  ]
}
