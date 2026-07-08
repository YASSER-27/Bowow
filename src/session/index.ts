import { TodoManager } from './todo'
import { isOverflow, estimateTokenCount, type OverflowConfig } from './overflow'
import { compact, truncateToolOutput, buildCompactionPrompt } from './compaction'
import { buildReminderBlock, type ReminderConfig } from './reminders'
import { delay, isRetryable, shouldRetry, sleep } from './retry'
import { estimate } from '../util/token'

export interface SessionMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  type?: string
  tokenCount?: number
  timestamp: number
}

export interface SessionConfig {
  maxContextTokens: number
  maxOutputTokens: number
  compactionEnabled: boolean
  compactionReserved?: number
  maxRetries: number
  overflowConfig: OverflowConfig
  reminderConfig?: ReminderConfig
}

const DEFAULT_SESSION_CONFIG: SessionConfig = {
  maxContextTokens: 128_000,
  maxOutputTokens: 4096,
  compactionEnabled: true,
  maxRetries: 3,
  overflowConfig: { auto: true, maxContextTokens: 128_000 },
}

export class SessionManager {
  messages: SessionMessage[] = []
  config: SessionConfig
  todoManager: TodoManager
  sessionId: string
  private compactionCount = 0

  constructor(sessionId: string, config?: Partial<SessionConfig>) {
    this.sessionId = sessionId
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config }
    this.todoManager = new TodoManager()
  }

  addMessage(msg: Omit<SessionMessage, 'timestamp' | 'tokenCount'>): SessionMessage {
    const full: SessionMessage = {
      ...msg,
      timestamp: Date.now(),
      tokenCount: estimate(msg.content),
    }
    this.messages.push(full)
    return full
  }

  getMessagesForLLM(): SessionMessage[] {
    let msgs = this.messages

    const systemMsgs = msgs.filter(m => m.role === 'system')
    const nonSystem = msgs.filter(m => m.role !== 'system')

    const tokens = estimateTokenCount(msgs.map(m => m.content))
    if (this.config.compactionEnabled && isOverflow(this.config.overflowConfig, tokens, this.config.maxOutputTokens)) {
      // Last compaction summary + recent messages
      const tail = nonSystem.slice(-4)
      const summary = msgs.find(m => m.id === 'system-compaction')?.content
      msgs = [
        ...systemMsgs,
        ...(summary ? [{ id: 'system-compaction', role: 'system' as const, content: `Previous context summary:\n${summary}`, timestamp: Date.now(), tokenCount: 0 }] : []),
        ...tail,
      ]
    }

    return msgs
  }

  async compact(summarizeFn: (msgs: SessionMessage[]) => Promise<string>): Promise<void> {
    if (!this.config.compactionEnabled) return
    const result = await compact(this.messages, summarizeFn)
    if (result.summary) {
      this.compactionCount++
      this.messages = [
        { id: 'system-compaction', role: 'system', content: `Context summary (${this.compactionCount}):\n${result.summary}`, timestamp: Date.now(), tokenCount: 0 },
        ...this.messages.slice(-result.preservedMessages),
      ]
    }
  }

  getReminderBlock(): string {
    return buildReminderBlock(this.config.reminderConfig)
  }

  buildSystemPrompt(): string {
    const parts: string[] = []
    const reminders = this.getReminderBlock()
    if (reminders) parts.push(reminders)

    const todos = this.todoManager.toPrompt(this.sessionId)
    if (todos) parts.push(`## Todo\n${todos}`)

    return parts.join('\n\n')
  }

  async withRetry<T>(fn: (attempt: number) => Promise<T>, onError?: (err: any, attempt: number) => void): Promise<T> {
    let lastError: any
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn(attempt)
      } catch (err: any) {
        lastError = err
        onError?.(err, attempt)
        if (!isRetryable(err) || !shouldRetry(attempt, this.config.maxRetries)) throw err
        const waitMs = delay(attempt, err)
        await sleep(waitMs)
      }
    }
    throw lastError
  }
}
