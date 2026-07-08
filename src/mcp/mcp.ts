const isElectron = typeof process !== 'undefined' && process.versions?.electron

export interface MCPTool {
  name: string
  description: string
  inputSchema: Record<string, any>
}

export interface MCPResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface MCPPrompt {
  name: string
  description: string
  arguments: Array<{ name: string; description: string; required?: boolean }>
}

export interface MCPServerConfig {
  name: string
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

export class MCPClient {
  private process: any = null
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
  private msgId = 0
  private buffer = ''
  public name: string
  private tools: MCPTool[] = []
  private resources: MCPResource[] = []
  private prompts: MCPPrompt[] = []
  private initialized = false

  constructor(public config: MCPServerConfig) {
    this.name = config.name
  }

  async connect(): Promise<void> {
    if (this.config.url) return this.connectHTTP()
    return this.connectStdio()
  }

  private async connectStdio(): Promise<void> {
    if (!isElectron) { console.warn('[MCP] stdio not available in browser'); return }
    const { spawn } = require('child_process')
    const cmd = this.config.command
    if (!cmd) throw new Error('No command configured')
    this.process = spawn(cmd, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
      shell: true,
    })
    this.process.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString('utf8')
      this.processBuffer()
    })
    this.process.stderr?.on('data', (data: Buffer) => {
      console.warn(`[MCP:${this.name}] stderr:`, data.toString())
    })
    this.process.on('exit', (code: number) => {
      console.warn(`[MCP:${this.name}] exited with code`, code)
      this.initialized = false
    })
    await this.send('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'bowow', version: '1.0.0' },
    })
    this.initialized = true
    await this.sendNotification('initialized')
    await this.refreshCapabilities()
  }

  private async connectHTTP(): Promise<void> {
    const res = await fetch(`${this.config.url}/initialize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bowow', version: '1.0.0' } }),
    })
    if (!res.ok) throw new Error(`MCP HTTP connect failed: ${res.status}`)
    this.initialized = true
    await this.refreshCapabilities()
  }

  private async send(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId
      this.pending.set(id, { resolve, reject })
      const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
      this.process?.stdin?.write(line)
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`MCP request ${method} timed out`)) }
      }, 30000)
    })
  }

  private sendNotification(method: string, params?: any): void {
    this.process?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
        }
      } catch {}
    }
  }

  private async refreshCapabilities(): Promise<void> {
    try { const r = await this.send('tools/list'); this.tools = r?.tools || [] } catch {}
    try { const r = await this.send('resources/list'); this.resources = r?.resources || [] } catch {}
    try { const r = await this.send('prompts/list'); this.prompts = r?.prompts || [] } catch {}
  }

  getTools(): MCPTool[] { return this.tools }
  getResources(): MCPResource[] { return this.resources }
  getPrompts(): MCPPrompt[] { return this.prompts }

  async callTool(name: string, args: Record<string, any>): Promise<any> {
    if (!this.initialized) await this.connect()
    return this.send('tools/call', { name, arguments: args })
  }

  async readResource(uri: string): Promise<any> {
    if (!this.initialized) await this.connect()
    return this.send('resources/read', { uri })
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<any> {
    if (!this.initialized) await this.connect()
    return this.send('prompts/get', { name, arguments: args })
  }

  disconnect(): void {
    this.process?.kill()
    this.process = null
    this.initialized = false
  }
}

export class MCPServerManager {
  private clients = new Map<string, MCPClient>()

  add(config: MCPServerConfig): MCPClient {
    const existing = this.clients.get(config.name)
    if (existing) existing.disconnect()
    const client = new MCPClient(config)
    this.clients.set(config.name, client)
    return client
  }

  get(name: string): MCPClient | undefined { return this.clients.get(name) }
  list(): MCPClient[] { return Array.from(this.clients.values()) }

  remove(name: string): void {
    this.clients.get(name)?.disconnect()
    this.clients.delete(name)
  }

  disconnectAll(): void {
    for (const client of this.clients.values()) client.disconnect()
    this.clients.clear()
  }

  async getAllTools(): Promise<Array<{ server: string; tool: MCPTool }>> {
    const all: Array<{ server: string; tool: MCPTool }> = []
    for (const [name, client] of this.clients) {
      try { for (const tool of client.getTools()) all.push({ server: name, tool }) } catch {}
    }
    return all
  }
}

export const defaultMCPServerManager = new MCPServerManager()
