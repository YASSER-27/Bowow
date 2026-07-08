import type { BuildTimelineItem } from '../types'

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  id?: string
}

export function toLLMMessages(timeline: BuildTimelineItem[], systemPrompt?: string): LLMMessage[] {
  const messages: LLMMessage[] = []
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt })
  }
  for (const item of timeline) {
    if (item.type === 'file' || item.type === 'tool') continue
    if (!item.content) continue
    if (item.type === 'assistant') {
      messages.push({ role: 'assistant', content: item.content, id: item.id })
    } else if (item.type === 'user') {
      messages.push({ role: 'user', content: item.content, id: item.id })
    }
  }
  return messages
}
