import { countTotalInputTokens, countChatHistoryTokens } from './tokenizer'
import { addToolCallDeltaToState, type ToolCallState } from './toolCallState'
import { parse as incrementalParseJson } from 'partial-json'

// ── Stream Callbacks ──────────────────────────────────────────────
export interface BuildCallbacks {
  onContent?: (delta: string) => void
  onContentComplete?: (content: string) => void
  onToolStart?: (toolName: string, toolArgs?: any) => void
  onToolResult?: (result: string, toolName: string, status: string) => void
  onToolError?: (error: string, toolName?: string) => void
}

// ── Tool & Message Types ──────────────────────────────────────────
export interface BuildToolCall {
  id?: string
  name: string
  arguments: any
  argumentsStr?: string
}

export interface BuildMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>
}

export interface ModelConfig {
  model: string
  defaultCompletionOptions?: {
    contextLength?: number
    maxTokens?: number
    temperature?: number
  }
}

// ── Streaming Chunk Processing ────────────────────────────────────
export function processChunkContent(
  content: string,
  aiResponse: string,
  callbacks?: BuildCallbacks,
): string {
  const updated = aiResponse + content
  callbacks?.onContent?.(content)
  return updated
}

export function processToolCallDelta(
  delta: any,
  toolCallsMap: Map<string, BuildToolCall>,
  indexToIdMap: Map<number, string>,
  toolCallStates?: Map<string, ToolCallState>,
): void {
  let id = ''
  if (delta.id) {
    id = delta.id
    if (delta.index !== undefined) indexToIdMap.set(delta.index, id)
  } else if (delta.index !== undefined) {
    id = indexToIdMap.get(delta.index) || ''
  }
  if (!id) return

  if (toolCallStates) {
    const prevState = toolCallStates.get(id)
    const newState = addToolCallDeltaToState(delta, prevState as any)
    toolCallStates.set(id, newState)

    if (!toolCallsMap.has(id)) {
      toolCallsMap.set(id, { id, name: '', arguments: {}, argumentsStr: '' })
    }
    const tc = toolCallsMap.get(id)!
    tc.name = newState.name
    tc.argumentsStr = newState.args
    tc.arguments = newState.parsedArgs
  } else {
    // Fallback to simple merging
    if (!toolCallsMap.has(id)) {
      toolCallsMap.set(id, { id, name: '', arguments: {}, argumentsStr: '' })
    }
    const tc = toolCallsMap.get(id)!
    if (delta.function?.name) tc.name = delta.function.name
    if (delta.function?.arguments) {
      tc.argumentsStr = (tc.argumentsStr || '') + delta.function.arguments
      try { tc.arguments = JSON.parse(tc.argumentsStr!) } catch {}
    }
  }
}

export function parseToolCallsFromMap(
  toolCallsMap: Map<string, BuildToolCall>,
): BuildToolCall[] {
  return Array.from(toolCallsMap.values()).filter(tc => tc.name)
}

// ── Context Validation ────────────────────────────────────────────
export interface ValidationResult {
  isValid: boolean
  error?: string
  inputTokens?: number
  contextLimit?: number
  maxTokens?: number
}

function toChatHistoryItem(msg: BuildMessage): any {
  return {
    message: {
      role: msg.role,
      content: msg.content,
      ...(msg.toolCalls ? { toolCalls: msg.toolCalls } : {}),
    },
    contextItems: [],
  }
}

export function validateContextBeforeApi(
  messages: BuildMessage[],
  model: ModelConfig,
  systemMessage?: string,
  tools?: any[],
): ValidationResult {
  const tokenizerModel = {
    model: model.model,
    defaultCompletionOptions: model.defaultCompletionOptions,
  }

  let inputTokens = 0
  try {
    inputTokens = countTotalInputTokens({
      chatHistory: messages.map(toChatHistoryItem),
      systemMessage,
      tools,
      model: tokenizerModel,
    })
  } catch {
    // Fallback: rough estimate based on text length
    inputTokens = messages.reduce((sum, m) => sum + Math.ceil((m.content?.length || 0) / 4), 0)
  }
  const contextLimit = model.defaultCompletionOptions?.contextLength ?? 200_000
  const maxTokens = model.defaultCompletionOptions?.maxTokens ?? 0
  const reservedForOutput = maxTokens > 0 ? maxTokens : Math.ceil(contextLimit * 0.35)
  const totalRequired = inputTokens + reservedForOutput + 100

  if (totalRequired > contextLimit) {
    return {
      isValid: false,
      error: `Context length exceeded: input (${inputTokens.toLocaleString()}) + max_tokens (${reservedForOutput.toLocaleString()}) = ${totalRequired.toLocaleString()} > context_limit (${contextLimit.toLocaleString()})`,
      inputTokens, contextLimit, maxTokens: reservedForOutput,
    }
  }
  return { isValid: true, inputTokens, contextLimit, maxTokens: reservedForOutput }
}

// ── Prune Messages ────────────────────────────────────────────────
export function pruneLastMessages(
  messages: BuildMessage[],
): BuildMessage[] {
  if (messages.length <= 1) return messages
  const secondLast = messages[messages.length - 2]
  if (secondLast.role === 'assistant' && secondLast.toolCalls?.length) {
    return messages.slice(0, -2)
  }
  if (secondLast.role === 'user') return messages.slice(0, -2)
  return messages.slice(0, -1)
}

// ── Stream Chunk Types ────────────────────────────────────────────
interface StreamChunk {
  type: 'content' | 'tool_call'
  text?: string
  name?: string
  arguments?: any
  index?: number
  id?: string
}

function parseStreamLine(line: string, provider: string): StreamChunk | null {
  if (provider === 'gemini') {
    if (!line.trim()) return null
    try {
      const data = JSON.parse(line)
      const candidate = data.candidates?.[0]
      if (!candidate?.content?.parts) return null
      let lastChunk: StreamChunk | null = null
      for (const part of candidate.content.parts) {
        if (part.thought) continue
        if (part.text) lastChunk = { type: 'content', text: part.text }
        if (part.functionCall) {
          lastChunk = { type: 'tool_call', name: part.functionCall.name, arguments: part.functionCall.args, index: 0, id: `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` }
        }
      }
      return lastChunk
    } catch { return null }
  }

  const trimmed = line.trim()
  if (!trimmed || trimmed === 'data: [DONE]') return null
  if (!trimmed.startsWith('data: ')) return null
  try {
    const parsed = JSON.parse(trimmed.slice(6))
    const delta = parsed.choices?.[0]?.delta
    if (!delta) return null
    if (delta.content) return { type: 'content', text: delta.content }
    if (delta.tool_calls) {
      const tc = delta.tool_calls[0]
      const args = tc.function?.arguments ? (() => { try { return JSON.parse(tc.function.arguments) } catch { return tc.function.arguments } })() : undefined
      return { type: 'tool_call', id: tc.id, name: tc.function?.name, arguments: args, index: tc.index }
    }
    return null
  } catch { return null }
}

// ── Execute Streaming API Call ────────────────────────────────────
export interface BuildInlineData {
  mimeType: string
  data: string
}

export async function executeStreamingApi(
  messages: BuildMessage[],
  model: ModelConfig,
  provider: string,
  baseUrl: string,
  apiKey: string,
  toolDefs: any[],
  callbacks: BuildCallbacks,
  signal: AbortSignal,
): Promise<{ text: string; toolCalls: BuildToolCall[]; inlineData?: BuildInlineData[] }> {
  // Retry server errors (5xx) up to 2 times
  let lastErr: any
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt))
    try {
      return await executeStreamingApiInner(messages, model, provider, baseUrl, apiKey, toolDefs, callbacks, signal)
    } catch (err: any) {
      if (err.status && err.status >= 500 && err.status < 600 && attempt < 2) {
        lastErr = err
        continue
      }
      throw err
    }
  }
  throw lastErr || new Error('Max retries exceeded')
}

async function executeStreamingApiInner(
  messages: BuildMessage[],
  model: ModelConfig,
  provider: string,
  baseUrl: string,
  apiKey: string,
  toolDefs: any[],
  callbacks: BuildCallbacks,
  signal: AbortSignal,
): Promise<{ text: string; toolCalls: BuildToolCall[]; inlineData?: BuildInlineData[] }> {
  // Validate context first
  const systemMsg = messages.find(m => m.role === 'system')
  const validation = validateContextBeforeApi(messages, model, systemMsg?.content, toolDefs)
  if (!validation.isValid) {
    const prunedMessages = pruneLastMessages(messages)
    if (prunedMessages.length < messages.length) {
      return executeStreamingApi(prunedMessages, model, provider, baseUrl, apiKey, toolDefs, callbacks, signal)
    }
    throw new Error(validation.error)
  }

  // Build request
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  let url = ''
  let body: any = {}

  const isGemini = provider === 'gemini'

  if (isGemini) {
    const cleanModel = model.model.replace(/^models\//, '')
    url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:streamGenerateContent?alt=sse`
    if (apiKey) headers['x-goog-api-key'] = apiKey
    const geminiContents = messages
      .filter(m => m.role !== 'system')
      .map(m => {
        const parts: any[] = [{ text: m.content }]
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            parts.push({ functionCall: { name: tc.function.name, args: tc.function.arguments } })
          }
        }
        return { role: m.role === 'assistant' ? 'model' : 'user', parts }
      })
    if (!geminiContents.length) throw new Error('Gemini API requires at least one user/assistant message')
    const isGemma = model.model.includes('gemma')
    body = {
      contents: geminiContents,
      generationConfig: { temperature: 0.2, maxOutputTokens: isGemma ? 8192 : 32768 },
    }
    if (toolDefs.length) body.tools = toolDefs.map(t => ({ functionDeclarations: [{ name: t.function.name, description: t.function.description, parameters: t.function.parameters }] }))
    if (systemMsg) {
      if (!isGemma) {
        body.systemInstruction = { parts: [{ text: systemMsg.content }] }
      } else {
        geminiContents.unshift({ role: 'user', parts: [{ text: `[System context]:\n${systemMsg.content}` }] })
      }
    }
    if (!isGemma && (model.model.includes('thinking') || model.model.includes('2.5'))) {
      body.generationConfig.thinkingConfig = { thinkingBudget: 0, includeThoughts: false }
    }

  } else {
    if (provider === 'openai') {
      url = 'https://api.openai.com/v1/chat/completions'
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    } else if (provider === 'openrouter') {
      url = 'https://openrouter.ai/api/v1/chat/completions'
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
    } else {
      url = `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
    }
    body = {
      model: model.model,
      messages: messages.filter(m => m.content || m.toolCalls),
      temperature: 0.2,
      max_tokens: 32768,
      stream: true,
      tools: toolDefs,
      tool_choice: 'auto',
    }
  }

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!res.ok) {
    let detail = ''
    try { detail = await res.text() } catch {}
    const msg = `API error: ${res.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`
    const err = new Error(msg) as any
    err.status = res.status
    err.type = res.status >= 500 ? 'server_error' : 'api_error'
    throw err
  }

  if (isGemini) {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullText = ''
    const toolCalls: BuildToolCall[] = []
    const inlineData: BuildInlineData[] = []
    let isFallbackToolMode = false
    let fallbackToolBuffer = ''
    let preFallbackText = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const jsonStr = line.slice(6).trim()
        if (!jsonStr || jsonStr === '[DONE]') continue
        try {
          const data = JSON.parse(jsonStr)
          const candidate = data.candidates?.[0]
          const parts = candidate?.content?.parts || []
          for (const part of parts) {
            if (part.thought) continue
            if (part.functionCall) {
              const tc: BuildToolCall = { id: `fc_${Date.now()}`, name: part.functionCall.name, arguments: part.functionCall.args || {} }
              toolCalls.push(tc)
            }
            if (part.text) {
              fullText += part.text
              if (!isFallbackToolMode) {
                if (looksLikeToolCallJson(fullText)) {
                  isFallbackToolMode = true
                  fallbackToolBuffer = fullText
                } else {
                  callbacks.onContent?.(part.text)
                  preFallbackText += part.text
                }
              } else {
                fallbackToolBuffer += part.text
              }
            }
            if (part.inlineData) {
              inlineData.push({ mimeType: part.inlineData.mimeType, data: part.inlineData.data })
            }
          }
        } catch {}
      }
    }
    if (isFallbackToolMode && fallbackToolBuffer.trim()) {
      const extracted = extractToolCallsFromText(fallbackToolBuffer)
      if (extracted.length > 0) {
        for (const item of extracted) {
          toolCalls.push({ name: item.name, arguments: item.args })
        }
      } else {
        callbacks.onContent?.('\n⚠ A tool call from the model could not be parsed and was dropped.')
      }
    }
    if (fullText) callbacks.onContentComplete?.(fullText)
    return { text: isFallbackToolMode ? preFallbackText : fullText, toolCalls, inlineData: inlineData.length > 0 ? inlineData : undefined }
  }

  // OpenAI-compatible streaming
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  const toolCallsMap = new Map<string, BuildToolCall>()
  const indexToIdMap = new Map<number, string>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const chunk = parseStreamLine(line, provider)
      if (!chunk) continue
      if (chunk.type === 'content' && chunk.text) {
        fullText += chunk.text
        callbacks.onContent?.(chunk.text)
      }
      if (chunk.type === 'tool_call') {
        const tcId = chunk.id || `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
        if (!toolCallsMap.has(tcId)) {
          toolCallsMap.set(tcId, { id: tcId, name: chunk.name || '', arguments: chunk.arguments || {}, argumentsStr: '' })
        }
        const existing = toolCallsMap.get(tcId)!
        if (chunk.name) existing.name = chunk.name
        if (typeof chunk.arguments === 'string') {
          existing.argumentsStr = (existing.argumentsStr || '') + chunk.arguments
          try { existing.arguments = JSON.parse(existing.argumentsStr!) } catch {}
        } else if (chunk.arguments && typeof chunk.arguments === 'object') {
          existing.arguments = { ...existing.arguments, ...chunk.arguments }
        }
      }
    }
  }

  if (fullText) callbacks.onContentComplete?.(fullText)

  const toolCalls = Array.from(toolCallsMap.values()).filter(tc => tc.name)
  return { text: fullText, toolCalls }
}

// ── Tool Call JSON Fallback Detection ──────────────────────────────

function stripCodeBlockMarkers(text: string): string {
  return text.replace(/^```[\w]*\n?/gm, '').replace(/\n?```\s*$/g, '').trim()
}

/** Detect Continue-style codeblock format: ```tool\nTOOL_NAME: xxx\nBEGIN_ARG: key\nvalue\nEND_ARG */
function parseContinueCodeblock(text: string): { name: string; args: Record<string, string> } | null {
  const lines = text.split('\n')
  let i = 0
  if (lines[i]?.trim().startsWith('```tool')) i++
  if (i >= lines.length) return null
  const nameLine = lines[i++].trim()
  const prefix = 'TOOL_NAME: '
  if (!nameLine.startsWith(prefix)) return null
  const name = nameLine.slice(prefix.length).trim()
  const args: Record<string, string> = {}
  let currentKey = ''
  let currentVal: string[] = []
  let inArg = false
  while (i < lines.length) {
    const line = lines[i++]
    if (line.startsWith('BEGIN_ARG: ')) {
      if (inArg && currentKey) args[currentKey] = currentVal.join('\n')
      currentKey = line.slice('BEGIN_ARG: '.length).trim()
      currentVal = []
      inArg = true
    } else if (line === 'END_ARG' || line === 'END_ARG ') {
      if (inArg && currentKey) args[currentKey] = currentVal.join('\n')
      currentKey = ''
      currentVal = []
      inArg = false
    } else if (line.startsWith('```')) {
      break
    } else if (inArg) {
      currentVal.push(line)
    }
  }
  if (inArg && currentKey) args[currentKey] = currentVal.join('\n')
  return { name, args }
}

export function looksLikeToolCallJson(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  const isJsonStructure = (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  const hasName = /"name"\s*:\s*"[^"]+"/.test(trimmed)
  const hasArgs = /"args"\s*:\s*\{/.test(trimmed) || /"arguments"\s*:\s*\{/.test(trimmed)
  const isKnownTool = /"name"\s*:\s*"(create_file|edit_file|read_file|ls|glob_search|grep_search|create_zip|run_command)"/.test(trimmed)
  return (hasName && hasArgs) || isKnownTool || (isJsonStructure && hasName) || /```tool\s*\nTOOL_NAME:\s*[^"]+"/.test(trimmed)
}

export function extractToolCallsFromText(text: string): { name: string; args: Record<string, string> }[] {
  const results: { name: string; args: Record<string, string> }[] = []
  const cleaned = stripCodeBlockMarkers(text)
  for (const candidate of [text, cleaned]) {
    try {
      const parsed = JSON.parse(candidate)
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of arr) {
        if (item?.name && typeof item.name === 'string') {
          results.push({ name: item.name, args: item.args || item.arguments || {} })
        }
      }
      if (results.length) return results
    } catch {}
  }
  try {
    const partial = incrementalParseJson(cleaned || text)
    if (partial && typeof partial === 'object') {
      const arr = Array.isArray(partial) ? partial : [partial]
      for (const item of arr) {
        if (item?.name && typeof item.name === 'string') {
          results.push({ name: item.name, args: item.args || item.arguments || {} })
        }
      }
      if (results.length) return results
    }
  } catch {}
  const cbResult = parseContinueCodeblock(text)
  if (cbResult) results.push(cbResult)
  return results
}
