import type { ProviderConfig, LLMRequest, LLMChunk, ProviderKind } from './provider'

export async function* streamLLM(config: ProviderConfig, req: LLMRequest): AsyncGenerator<LLMChunk> {
  switch (config.kind) {
    case 'openai':
    case 'custom':
      yield* streamOpenAI(config, req)
      break
    case 'anthropic':
      yield* streamAnthropic(config, req)
      break
    case 'google':
      yield* streamGoogle(config, req)
      break
    case 'azure':
      yield* streamAzure(config, req)
      break
    case 'copilot':
      yield* streamCopilot(config, req)
      break
    case 'deepseek':
      yield* streamDeepSeek(config, req)
      break
    default:
      yield { type: 'error', error: `Unsupported provider: ${config.kind}` }
  }
}

async function* streamOpenAI(config: ProviderConfig, req: LLMRequest): AsyncGenerator<LLMChunk> {
  const url = `${config.baseUrl || 'https://api.openai.com/v1'}/chat/completions`
  const body = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.7,
    max_tokens: req.maxTokens ?? 4096,
    stream: req.stream !== false,
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!res.ok) {
    const err = await res.text()
    yield { type: 'error', error: `OpenAI ${res.status}: ${err}` }
    return
  }
  if (body.stream) {
    const reader = res.body?.getReader()
    if (!reader) { yield { type: 'error', error: 'No response body' }; return }
    const decoder = new TextDecoder()
    let buffer = ''
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
        if (data === '[DONE]') { yield { type: 'done' }; return }
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta
          if (delta?.content) yield { type: 'text', text: delta.content }
          const finish = parsed.choices?.[0]?.finish_reason
          if (finish) {
            const usage = parsed.usage
            yield {
              type: 'done',
              finishReason: finish,
              usage: usage ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } : undefined,
            }
            return
          }
        } catch {}
      }
    }
    yield { type: 'done' }
  } else {
    const json = await res.json()
    const text = json.choices?.[0]?.message?.content || ''
    if (text) yield { type: 'text', text }
    yield {
      type: 'done',
      finishReason: json.choices?.[0]?.finish_reason,
      usage: json.usage ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens } : undefined,
    }
  }
}

async function* streamAnthropic(config: ProviderConfig, req: LLMRequest): AsyncGenerator<LLMChunk> {
  const url = `${config.baseUrl || 'https://api.anthropic.com/v1'}/messages`
  const systemMsg = req.messages.find(m => m.role === 'system')
  const messages = req.messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role,
    content: m.content,
  }))
  const body: any = {
    model: req.model,
    messages,
    max_tokens: req.maxTokens ?? 4096,
    stream: req.stream !== false,
  }
  if (systemMsg) body.system = systemMsg.content
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!res.ok) {
    const err = await res.text()
    yield { type: 'error', error: `Anthropic ${res.status}: ${err}` }
    return
  }
  if (body.stream) {
    const reader = res.body?.getReader()
    if (!reader) { yield { type: 'error', error: 'No response body' }; return }
    const decoder = new TextDecoder()
    let buffer = ''
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
        try {
          const parsed = JSON.parse(data)
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            yield { type: 'text', text: parsed.delta.text }
          }
          if (parsed.type === 'message_delta' && parsed.delta?.stop_reason) {
            yield {
              type: 'done',
              finishReason: parsed.delta.stop_reason,
              usage: parsed.usage ? { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens } : undefined,
            }
            return
          }
          if (parsed.type === 'message_stop') {
            yield { type: 'done' }
            return
          }
        } catch {}
      }
    }
    yield { type: 'done' }
  } else {
    const json = await res.json()
    const text = json.content?.[0]?.text || ''
    if (text) yield { type: 'text', text }
    yield {
      type: 'done',
      finishReason: json.stop_reason,
      usage: json.usage ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens } : undefined,
    }
  }
}

async function* streamGoogle(config: ProviderConfig, req: LLMRequest): AsyncGenerator<LLMChunk> {
  const url = `${config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta'}/models/${req.model}:streamGenerateContent`
  const contents = req.messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : m.role,
    parts: [{ text: m.content }],
  }))
  const body = { contents, generationConfig: { temperature: req.temperature ?? 0.7, maxOutputTokens: req.maxTokens ?? 8192 } }
  const res = await fetch(`${url}?alt=sse&key=${config.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!res.ok) {
    const err = await res.text()
    yield { type: 'error', error: `Google ${res.status}: ${err}` }
    return
  }
  const reader = res.body?.getReader()
  if (!reader) { yield { type: 'error', error: 'No response body' }; return }
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      try {
        const parsed = JSON.parse(trimmed.slice(6))
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text
        if (text) yield { type: 'text', text }
        const finish = parsed.candidates?.[0]?.finishReason
        if (finish && finish !== 'FINISH_REASON_UNSPECIFIED') {
          yield { type: 'done', finishReason }
          return
        }
      } catch {}
    }
  }
  yield { type: 'done' }
}

async function* streamAzure(config: ProviderConfig, req: LLMRequest): AsyncGenerator<LLMChunk> {
  const url = `${config.baseUrl}/openai/deployments/${req.model}/chat/completions?api-version=2024-02-15-preview`
  const body = {
    messages: req.messages,
    temperature: req.temperature ?? 0.7,
    max_tokens: req.maxTokens ?? 4096,
    stream: req.stream !== false,
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': config.apiKey },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!res.ok) {
    const err = await res.text()
    yield { type: 'error', error: `Azure ${res.status}: ${err}` }
    return
  }
  if (body.stream) {
    const reader = res.body?.getReader()
    if (!reader) { yield { type: 'error', error: 'No response body' }; return }
    const decoder = new TextDecoder()
    let buffer = ''
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
        if (data === '[DONE]') { yield { type: 'done' }; return }
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta
          if (delta?.content) yield { type: 'text', text: delta.content }
          const finish = parsed.choices?.[0]?.finish_reason
          if (finish) {
            yield {
              type: 'done',
              finishReason: finish,
              usage: parsed.usage ? { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens } : undefined,
            }
            return
          }
        } catch {}
      }
    }
    yield { type: 'done' }
  } else {
    const json = await res.json()
    const text = json.choices?.[0]?.message?.content || ''
    if (text) yield { type: 'text', text }
    yield {
      type: 'done',
      finishReason: json.choices?.[0]?.finish_reason,
      usage: json.usage ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens } : undefined,
    }
  }
}

async function* streamCopilot(config: ProviderConfig, req: LLMRequest): AsyncGenerator<LLMChunk> {
  yield { type: 'error', error: 'Copilot streaming not yet implemented' }
}

async function* streamDeepSeek(config: ProviderConfig, req: LLMRequest): AsyncGenerator<LLMChunk> {
  const url = `${(config.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')}/v1/chat/completions`
  const body: any = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.7,
    max_tokens: req.maxTokens ?? 8192,
    stream: req.stream !== false,
  }
  if (req.thinking) body.thinking = req.thinking
  if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body),
    signal: req.signal,
  })
  if (!res.ok) {
    const err = await res.text()
    yield { type: 'error', error: `DeepSeek ${res.status}: ${err}` }
    return
  }
  if (body.stream) {
    const reader = res.body?.getReader()
    if (!reader) { yield { type: 'error', error: 'No response body' }; return }
    const decoder = new TextDecoder()
    let buffer = ''
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
        if (data === '[DONE]') { yield { type: 'done' }; return }
        try {
          const parsed = JSON.parse(data)
          const delta = parsed.choices?.[0]?.delta
          if (delta?.content) yield { type: 'text', text: delta.content }
          if (delta?.reasoning_content) yield { type: 'text', text: delta.reasoning_content }
          const finish = parsed.choices?.[0]?.finish_reason
          if (finish) {
            yield {
              type: 'done',
              finishReason: finish,
              usage: parsed.usage ? { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens } : undefined,
            }
            return
          }
        } catch {}
      }
    }
    yield { type: 'done' }
  } else {
    const json = await res.json()
    const choice = json.choices?.[0]?.message
    const text = choice?.content || choice?.reasoning_content || ''
    const thinkingText = choice?.reasoning_content
    let fullText = text
    if (thinkingText) fullText = `[Thinking]\n${thinkingText}\n[/Thinking]\n${text}`
    if (fullText) yield { type: 'text', text: fullText }
    yield {
      type: 'done',
      finishReason: json.choices?.[0]?.finish_reason,
      usage: json.usage ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens } : undefined,
    }
  }
}
