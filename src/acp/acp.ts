/**
 * ACP (Agent Client Protocol) — Agent-to-agent communication.
 *
 * Enables agents to initialize sessions, exchange prompts,
 * manage session lifecycle, and handle authentication.
 */

export interface ACPInitializeRequest {
  protocolVersion: string
  capabilities: ACPCapabilities
  clientInfo: ACPClientInfo
}

export interface ACPInitializeResponse {
  protocolVersion: string
  capabilities: ACPCapabilities
  serverInfo: ACPClientInfo
}

export interface ACPCapabilities {
  sessionManagement?: boolean
  prompts?: boolean
  tools?: boolean
  streaming?: boolean
  authentication?: string[]
}

export interface ACPClientInfo {
  name: string
  version: string
}

export interface ACPSessionInfo {
  id: string
  created: number
  updated: number
  model?: string
  mode?: string
  messageCount: number
}

export interface ACPNewSessionRequest {
  id?: string
  model?: string
  mode?: 'normal' | 'plan' | 'architect'
  config?: Record<string, any>
}

export interface ACPNewSessionResponse {
  id: string
  created: number
}

export interface ACPPromptRequest {
  sessionId: string
  message: string
  stream?: boolean
  signal?: AbortSignal
}

export interface ACPPromptResponse {
  text: string
  role: 'assistant'
  sessionId: string
  usage?: ACPUsage
}

export interface ACPUsage {
  inputTokens: number
  outputTokens: number
}

export interface ACPAuthenticateRequest {
  method: string
  credentials?: Record<string, string>
}

export interface ACPAuthenticateResponse {
  success: boolean
  token?: string
  error?: string
}

export interface ACPMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  id?: string
  timestamp?: number
}

export interface ACPSession {
  id: string
  created: number
  updated: number
  model?: string
  mode?: string
  messages: ACPMessage[]
}

/**
 * ACP Agent — implements server-side of the Agent Client Protocol.
 */
export class ACPAgent {
  private sessions = new Map<string, ACPSession>()
  private authTokens = new Set<string>()

  capabilities: ACPCapabilities = {
    sessionManagement: true,
    prompts: true,
    streaming: true,
    authentication: ['token'],
  }

  info: ACPClientInfo = { name: 'bowow-agent', version: '1.0.0' }

  initialize(req: ACPInitializeRequest): ACPInitializeResponse {
    return {
      protocolVersion: req.protocolVersion || '2024-11-05',
      capabilities: this.capabilities,
      serverInfo: this.info,
    }
  }

  authenticate(req: ACPAuthenticateRequest): ACPAuthenticateResponse {
    if (req.method === 'token' && req.credentials?.token) {
      this.authTokens.add(req.credentials.token)
      return { success: true, token: req.credentials.token }
    }
    return { success: false, error: `Unsupported auth method: ${req.method}` }
  }

  verifyAuth(token?: string): boolean {
    if (this.authTokens.size === 0) return true // no auth required
    return !!token && this.authTokens.has(token)
  }

  newSession(req: ACPNewSessionRequest): ACPNewSessionResponse {
    const id = req.id || `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.sessions.set(id, {
      id,
      created: Date.now(),
      updated: Date.now(),
      model: req.model,
      mode: req.mode,
      messages: [],
    })
    return { id, created: Date.now() }
  }

  loadSession(id: string): ACPSession | undefined {
    return this.sessions.get(id)
  }

  listSessions(): ACPSessionInfo[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      created: s.created,
      updated: s.updated,
      model: s.model,
      mode: s.mode,
      messageCount: s.messages.length,
    }))
  }

  resumeSession(id: string): ACPSession | undefined {
    const session = this.sessions.get(id)
    if (session) session.updated = Date.now()
    return session
  }

  closeSession(id: string): boolean {
    return this.sessions.delete(id)
  }

  forkSession(id: string, config?: Record<string, any>): ACPNewSessionResponse | undefined {
    const original = this.sessions.get(id)
    if (!original) return undefined
    const forked = this.newSession({
      model: original.model,
      mode: original.mode as any,
      config,
    })
    const forkedSession = this.sessions.get(forked.id)
    if (forkedSession) {
      forkedSession.messages = [...original.messages]
    }
    return forked
  }

  prompt(req: ACPPromptRequest, handler: (msg: string, sessionId: string) => Promise<string>): Promise<ACPPromptResponse> {
    const session = this.sessions.get(req.sessionId)
    if (!session) throw new Error(`Session not found: ${req.sessionId}`)

    session.messages.push({ role: 'user', content: req.message, id: crypto.randomUUID?.() || `${Date.now()}`, timestamp: Date.now() })
    session.updated = Date.now()

    return handler(req.message, req.sessionId).then(text => {
      session.messages.push({ role: 'assistant', content: text, id: crypto.randomUUID?.() || `${Date.now()}`, timestamp: Date.now() })
      session.updated = Date.now()
      return {
        text,
        role: 'assistant',
        sessionId: req.sessionId,
        usage: { inputTokens: Math.round(req.message.length / 4), outputTokens: Math.round(text.length / 4) },
      }
    })
  }

  setSessionConfig(id: string, config: Record<string, any>): void {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    if (config.model) session.model = config.model
    if (config.mode) session.mode = config.mode
    session.updated = Date.now()
  }
}

/**
 * ACP Client — connects to a remote ACP agent.
 */
export class ACPClient {
  private baseUrl: string
  private token?: string
  private initialized = false

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  private async request<T>(method: string, path: string, body?: any, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    })
    if (!res.ok) throw new Error(`ACP request failed: ${res.status} ${await res.text()}`)
    return res.json()
  }

  async initialize(): Promise<ACPInitializeResponse> {
    const res = await this.request<ACPInitializeResponse>('POST', '/acp/initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { prompts: true, streaming: true },
      clientInfo: { name: 'bowow', version: '1.0.0' },
    })
    this.initialized = true
    return res
  }

  async authenticate(method: string, credentials: Record<string, string>): Promise<boolean> {
    const res = await this.request<ACPAuthenticateResponse>('POST', '/acp/authenticate', { method, credentials })
    if (res.token) this.token = res.token
    return res.success
  }

  async newSession(req: ACPNewSessionRequest): Promise<ACPNewSessionResponse> {
    return this.request('POST', '/acp/sessions', req)
  }

  async listSessions(): Promise<ACPSessionInfo[]> {
    return this.request('GET', '/acp/sessions')
  }

  async loadSession(id: string): Promise<any> {
    return this.request('GET', `/acp/sessions/${id}`)
  }

  async closeSession(id: string): Promise<void> {
    return this.request('DELETE', `/acp/sessions/${id}`)
  }

  async prompt(req: ACPPromptRequest): Promise<ACPPromptResponse> {
    return this.request('POST', `/acp/sessions/${req.sessionId}/prompt`, {
      message: req.message,
      stream: req.stream,
    }, req.signal)
  }
}
