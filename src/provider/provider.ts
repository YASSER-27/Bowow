export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'azure' | 'copilot' | 'deepseek' | 'custom'

export interface ProviderConfig {
  kind: ProviderKind
  label: string
  apiKey: string
  baseUrl?: string
  models: string[]
  defaultModel: string
}

export interface ModelInfo {
  id: string
  provider: ProviderKind
  label: string
  maxTokens: number
  contextWindow: number
  supportsStreaming: boolean
}

export interface ProviderCapabilities {
  streaming: boolean
  functionCalling: boolean
  vision: boolean
  maxContextWindow: number
}

const PROVIDER_DEFAULTS: Record<ProviderKind, Omit<ProviderConfig, 'apiKey' | 'label'>> = {
  openai: { kind: 'openai', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'], defaultModel: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { kind: 'anthropic', models: ['claude-3-5-sonnet-20240620', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'], defaultModel: 'claude-3-5-sonnet-20240620', baseUrl: 'https://api.anthropic.com/v1' },
  google: { kind: 'google', models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash'], defaultModel: 'gemini-1.5-pro', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  azure: { kind: 'azure', models: ['gpt-4o', 'gpt-4o-mini'], defaultModel: 'gpt-4o', baseUrl: '' },
  copilot: { kind: 'copilot', models: ['gpt-4o', 'claude-3.5-sonnet'], defaultModel: 'gpt-4o', baseUrl: '' },
  deepseek: { kind: 'deepseek', models: ['deepseek-v4-pro', 'deepseek-v4-flash-free'], defaultModel: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com' },
  custom: { kind: 'custom', models: [], defaultModel: '', baseUrl: '' },
}

export interface LLMRequest {
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  temperature?: number
  maxTokens?: number
  stream?: boolean
  signal?: AbortSignal
  thinking?: { type: 'enabled' | 'disabled' }
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export interface LLMChunk {
  type: 'text' | 'done' | 'error'
  text?: string
  finishReason?: string
  usage?: { inputTokens: number; outputTokens: number }
  error?: string
}

export class ProviderManager {
  private providers: Map<string, ProviderConfig> = new Map()

  add(config: ProviderConfig): void {
    this.providers.set(config.label, config)
  }

  remove(label: string): void {
    this.providers.delete(label)
  }

  get(label: string): ProviderConfig | undefined {
    return this.providers.get(label)
  }

  list(): ProviderConfig[] {
    return Array.from(this.providers.values())
  }

  getDefaultProviders(): ProviderConfig[] {
    return (Object.keys(PROVIDER_DEFAULTS) as ProviderKind[])
      .filter(k => k !== 'custom')
      .map(kind => ({
        ...PROVIDER_DEFAULTS[kind],
        label: kind.charAt(0).toUpperCase() + kind.slice(1),
        apiKey: '',
      }))
  }

  getCapabilities(kind: ProviderKind): ProviderCapabilities {
    switch (kind) {
      case 'openai': return { streaming: true, functionCalling: true, vision: true, maxContextWindow: 128000 }
      case 'anthropic': return { streaming: true, functionCalling: true, vision: true, maxContextWindow: 200000 }
      case 'google': return { streaming: true, functionCalling: true, vision: true, maxContextWindow: 1048576 }
      case 'azure': return { streaming: true, functionCalling: true, vision: true, maxContextWindow: 128000 }
      case 'copilot': return { streaming: true, functionCalling: true, vision: true, maxContextWindow: 128000 }
      case 'deepseek': return { streaming: true, functionCalling: true, vision: false, maxContextWindow: 128000 }
      case 'custom': return { streaming: true, functionCalling: false, vision: false, maxContextWindow: 32000 }
    }
  }
}

export const defaultProviderManager = new ProviderManager()
