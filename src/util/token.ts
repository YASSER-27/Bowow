const CHARS_PER_TOKEN = 4
const MAX_TOKENS_CACHE = 1_000_000

export const estimate = (input: string): number =>
  Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

export const truncate = (text: string, maxTokens: number): string => {
  const maxChars = maxTokens * CHARS_PER_TOKEN
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n... [truncated]'
}

export const estimateTotal = (items: string[]): number =>
  items.reduce((sum, s) => sum + estimate(s), 0)
