import { toolRegistry } from '../tool/registry'
import { toLLMMessages } from './to-llm-message'
import type { BuildTimelineItem } from '../types'
import { executeTask } from '../tool/task'
import { streamLLM } from '../provider/llm-client'

export interface RunTurnInput {
  sessionID: string
  agent: string
  buildId: number
  timeline: BuildTimelineItem[]
  systemPrompt?: string
  userMessage: string
  attachedImage?: string | null
  apiSettings: {
    provider: string
    baseUrl: string
    model: string
    apiKeys: Record<string, string>
  }
  onChunk: (chunk: string) => void
  onToolStart: (name: string, path?: string) => void
  onToolResult: (name: string, path: string, content: string, status: 'success' | 'error') => void
  signal: AbortSignal
}

export interface RunTurnResult {
  assistantContent: string
  needsContinuation: boolean
  step: number
}

const MAX_STEPS = 30

/** Run one agent turn: send request to LLM, stream response, settle tools, return result. */
export async function runTurn(input: RunTurnInput, step: number): Promise<RunTurnResult> {
  const { sessionID, agent, buildId, timeline, systemPrompt, userMessage, attachedImage, apiSettings, onChunk, onToolStart, onToolResult, signal } = input

  const materialization = toolRegistry.materialize()

  let messages = toLLMMessages(timeline, systemPrompt)
  const userContent = attachedImage
    ? `${userMessage}\n\n[Image attached: ${attachedImage.substring(0, 100)}...]`
    : userMessage
  messages.push({ role: 'user', content: userContent })

  const { provider, baseUrl, model, apiKeys } = apiSettings
  const apiKey = apiKeys[provider] || ''
  const apiUrl = getApiUrl(provider, baseUrl)

  const response = await streamFromProvider({
    provider, apiUrl, apiKey, model,
    messages: messages as any,
    tools: materialization.definitions as any,
    signal,
    onChunk: (text) => onChunk(text),
  })

  let assistantContent = ''
  let toolCalls: { id: string; name: string; args: Record<string, any> }[] = []

  if (response.toolCalls && response.toolCalls.length > 0) {
    toolCalls = response.toolCalls
  }
  assistantContent = response.text || ''

  // Settle tool calls
  if (toolCalls.length > 0) {
    const settlements = await Promise.allSettled(
      toolCalls.map(async (call) => {
        if (signal.aborted) throw new Error('Aborted')

        onToolStart(call.name, call.args.path)

        // Handle task tool specially - spawn subagent
        if (call.name === 'task') {
          try {
            const result = await executeTask({
              description: call.args.description || '',
              prompt: call.args.prompt || '',
              subagent_type: call.args.subagent_type || 'general',
              background: call.args.background,
              parentSessionID: sessionID,
              buildId,
              apiSettings,
            })
            return `task(${call.args.subagent_type}): completed - ${result.output}`
          } catch (err: any) {
            return `task(${call.args.subagent_type}): ERROR - ${err.message}`
          }
        }

        // Regular tool execution
        const settleResult = await materialization.settle({
          sessionID, agent, assistantMessageID: `msg_${Date.now()}`,
          call: { id: call.id, name: call.name, input: call.args },
        })
        onToolResult(call.name, call.args.path || '', settleResult.result.value, settleResult.result.type === 'success' ? 'success' : 'error')
        return `${call.name}(${call.args.path || ''}): ${settleResult.result.type === 'success' ? 'OK' : 'ERROR - ' + settleResult.result.value}`
      })
    )

    // If there were tool calls, we need a continuation
    return { assistantContent, needsContinuation: true, step: step + 1 }
  }

  return { assistantContent, needsContinuation: false, step: step + 1 }
}

/** Run agent with inline tool handling (used by task tool for subagents) */
export async function runAgent(params: {
  sessionID: string
  agent: string
  buildId: number
  systemPrompt: string
  toolNames: string[]
  apiSettings?: {
    provider: string
    baseUrl: string
    model: string
    apiKeys: Record<string, string>
  }
  signal: AbortSignal
  onChunk: (text: string) => void
}): Promise<void> {
  const { sessionID, agent, buildId, systemPrompt, apiSettings, signal, onChunk } = params

  if (!apiSettings) throw new Error('API settings required')

  let step = 1
  let needsContinuation = true
  const messages: { role: string; content: string }[] = []

  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }

  while (needsContinuation && step <= MAX_STEPS) {
    if (signal.aborted) break

    const { provider, baseUrl, model, apiKeys } = apiSettings
    const apiKey = apiKeys[provider] || ''
    const apiUrl = getApiUrl(provider, baseUrl)
    const materialization = toolRegistry.materialize()

    const response = await streamFromProvider({
      provider, apiUrl, apiKey, model,
      messages: messages as any,
      tools: materialization.definitions.filter(t => params.toolNames.includes(t.name)) as any,
      signal,
      onChunk: (text) => onChunk(text),
    })

    messages.push({ role: 'assistant', content: response.text || '' })
    onChunk(response.text || '')

    const toolCalls = response.toolCalls || []
    if (toolCalls.length === 0) break

    for (const call of toolCalls) {
      if (signal.aborted) break

      if (call.name === 'task') {
        try {
          const result = await executeTask({
            description: call.args.description || '',
            prompt: call.args.prompt || '',
            subagent_type: call.args.subagent_type || 'general',
            background: call.args.background,
            parentSessionID: sessionID,
            buildId,
            apiSettings,
          })
          messages.push({ role: 'user', content: `Task result:\n${result.output}` })
        } catch (err: any) {
          messages.push({ role: 'user', content: `Task error: ${err.message}` })
        }
      } else {
        try {
          const settleResult = await materialization.settle({
            sessionID, agent, assistantMessageID: `msg_${Date.now()}`,
            call: { id: call.id, name: call.name, input: call.args },
          })
          const resultText = settleResult.result.type === 'success'
            ? settleResult.result.value
            : `Error: ${settleResult.result.value}`
          messages.push({ role: 'user', content: `${call.name} result:\n${resultText}` })
        } catch (err: any) {
          messages.push({ role: 'user', content: `Tool error (${call.name}): ${err.message}` })
        }
      }
    }

    step++
  }
}

/** Main agent loop: run turns until done. */
export async function run(input: RunTurnInput): Promise<void> {
  let step = 1
  let needsContinuation = true
  while (needsContinuation && step <= MAX_STEPS) {
    const result = await runTurn(input, step)
    needsContinuation = result.needsContinuation
    step = result.step
    if (input.signal.aborted) break
  }
}

async function streamFromProvider(params: {
  provider: string; apiUrl: string; apiKey: string; model: string
  messages: { role: string; content: string }[]
  tools: any[]
  signal: AbortSignal
  onChunk: (text: string) => void
}): Promise<{ text: string; toolCalls?: { id: string; name: string; args: Record<string, any> }[] }> {
  const { provider, apiUrl, apiKey, model, messages, tools, signal, onChunk } = params
  let text = ''
  let toolCalls: { id: string; name: string; args: Record<string, any> }[] = []

  if (provider === 'gemini') {
    const result = await streamGemini(apiKey, model, messages, tools, signal, onChunk)
    text = result.text
    toolCalls = result.toolCalls
  } else {
    const result = await streamOpenAI(apiUrl, apiKey, model, messages, tools, signal, onChunk)
    text = result.text
    toolCalls = result.toolCalls
  }

  return { text, toolCalls }
}

/** Quick non-tool chat via streamLLM (for simple completions) */
export async function quickChat(apiSettings: { provider: string; baseUrl: string; model: string; apiKeys: Record<string, string> }, message: string): Promise<string> {
  const { provider, baseUrl, model, apiKeys } = apiSettings
  const apiKey = apiKeys[provider] || ''
  const providerKind = provider === 'deepseek' ? 'deepseek' as const : provider === 'openrouter' ? 'openai' as const : provider as any
  const config = { kind: providerKind, label: provider, apiKey, baseUrl, models: [], defaultModel: model }
  let result = ''
  try {
    for await (const chunk of streamLLM(config, { model, messages: [{ role: 'user', content: message }], stream: true })) {
      if (chunk.type === 'text' && chunk.text) result += chunk.text
      if (chunk.type === 'done') break
    }
  } catch (e: any) {
    return `Error: ${e.message}`
  }
  return result
}

async function streamGemini(apiKey: string, model: string, messages: any[], tools: any[], signal: AbortSignal, onChunk: (text: string) => void) {
  const cleanModel = model.replace(/^models\//, '')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:streamGenerateContent?alt=sse&key=${apiKey}`
  const contents = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
  const systemInstruction = messages.find(m => m.role === 'system')?.content

  const body: any = {
    contents,
    generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
  }
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] }
  if (tools.length) {
    body.tools = tools.map(t => ({
      functionDeclarations: [{ name: t.function.name, description: t.function.description, parameters: t.function.parameters }],
    }))
  }

  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`)
  if (!res.body) throw new Error('No response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  const toolCalls: { id: string; name: string; args: Record<string, any> }[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data)
        const candidate = parsed.candidates?.[0]
        if (!candidate) continue
        const part = candidate.content?.parts?.[0]
        if (part?.text) {
          fullText += part.text
          onChunk(part.text)
        }
        if (part?.functionCall) {
          toolCalls.push({
            id: `call_${toolCalls.length}`,
            name: part.functionCall.name,
            args: part.functionCall.args || {},
          })
        }
      } catch {}
    }
  }

  return { text: fullText, toolCalls }
}

async function streamOpenAI(apiUrl: string, apiKey: string, model: string, messages: any[], tools: any[], signal: AbortSignal, onChunk: (text: string) => void) {
  const url = `${apiUrl.replace(/\/+$/, '')}/chat/completions`
  const body: any = {
    model, messages,
    temperature: 0.2, max_tokens: 8192,
    stream: true,
  }
  if (tools.length) {
    body.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters },
    }))
    body.tool_choice = 'auto'
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`API error: ${res.status}${errText ? ' - ' + errText.slice(0, 200) : ''}`)
  }
  if (!res.body) throw new Error('No response body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  const toolCalls: { id: string; name: string; args: Record<string, any> }[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data)
        const choice = parsed.choices?.[0]
        if (!choice) continue
        const delta = choice.delta
        if (delta?.content) {
          fullText += delta.content
          onChunk(delta.content)
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0
            while (toolCalls.length <= idx) {
              toolCalls.push({ id: '', name: '', args: {} })
            }
            if (tc.id) toolCalls[idx].id = tc.id
            if (tc.function?.name) toolCalls[idx].name = tc.function.name
            if (tc.function?.arguments) {
              try {
                toolCalls[idx].args = JSON.parse(tc.function.arguments)
              } catch {
                toolCalls[idx].args = toolCalls[idx].args || {}
              }
            }
          }
        }
        if (choice.finish_reason === 'tool_calls') {
          // Tool calls are already collected
        }
      } catch {}
    }
  }

  return { text: fullText, toolCalls }
}

function getApiUrl(provider: string, baseUrl: string): string {
  if (baseUrl) return baseUrl
  if (provider === 'openai') return 'https://api.openai.com/v1'
  if (provider === 'openrouter') return 'https://openrouter.ai/api/v1'
  if (provider === 'deepseek') return 'https://api.deepseek.com/v1'
  return baseUrl
}
