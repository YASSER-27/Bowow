export interface OverflowConfig {
  auto: boolean
  reserved?: number
  maxContextTokens: number
}

export interface TokenCount {
  total: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const COMPACTION_BUFFER = 20_000

export const usable = (modelContext: number, maxOutputTokens: number, reserved?: number): number => {
  if (modelContext === 0) return 0
  const buf = reserved ?? Math.min(COMPACTION_BUFFER, maxOutputTokens)
  return Math.max(0, modelContext - buf)
}

export const isOverflow = (cfg: OverflowConfig, tokens: TokenCount, maxOutputTokens: number): boolean => {
  if (!cfg.auto) return false
  if (cfg.maxContextTokens === 0) return false
  const count = tokens.total || tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite
  return count >= usable(cfg.maxContextTokens, maxOutputTokens, cfg.reserved)
}

export const estimateTokenCount = (messages: string[]): TokenCount => {
  const CHARS_PER_TOKEN = 4
  const total = messages.reduce((s, m) => s + m.length, 0)
  const tokens = Math.round(total / CHARS_PER_TOKEN)
  return {
    total: tokens,
    input: tokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
}
