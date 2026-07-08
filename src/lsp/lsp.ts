const isElectron = typeof process !== 'undefined' && process.versions?.electron

export interface LSPServerConfig {
  name: string
  command: string
  args?: string[]
  language: string
  extensions: string[]
}

export interface LSPPosition { line: number; character: number }
export interface LSPRange { start: LSPPosition; end: LSPPosition }
export interface LSPLocation { uri: string; range: LSPRange }
export interface LSPDiagnostic { range: LSPRange; severity: 'error' | 'warning' | 'info' | 'hint'; message: string; source?: string; code?: string }
export interface LSPHover { contents: string; range?: LSPRange }
export interface LSPSymbol { name: string; kind: string; range: LSPRange; selectionRange: LSPRange; children?: LSPSymbol[] }

const SYMBOL_KINDS: Record<number, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class', 6: 'Method', 7: 'Property',
  8: 'Field', 9: 'Constructor', 10: 'Enum', 11: 'Interface', 12: 'Function', 13: 'Variable',
  14: 'Constant', 15: 'String', 16: 'Number', 17: 'Boolean', 18: 'Array', 19: 'Object',
  20: 'Key', 21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event', 25: 'Operator', 26: 'TypeParameter',
}

class LSPClient {
  private process: any = null
  private msgId = 0
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
  private buffer = ''
  private contentLength = 0
  private initialized = false
  public serverUri = ''

  constructor(public config: LSPServerConfig) {}

  async start(projectUri: string): Promise<void> {
    if (!isElectron) { console.warn('[LSP] not available in browser'); return }
    const { spawn } = require('child_process')
    this.serverUri = projectUri
    this.process = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env },
    })
    this.process.stdout?.on('data', (data: Buffer) => {
      this.buffer += data.toString('utf8')
      this.processResponseBuffer()
    })
    this.process.stderr?.on('data', (data: Buffer) => { console.warn(`[LSP:${this.config.name}] stderr:`, data.toString()) })
    this.process.on('exit', (code: number) => { console.warn(`[LSP:${this.config.name}] exited with code`, code); this.initialized = false })
    await this.send('initialize', {
      processId: process.pid, rootUri: projectUri,
      capabilities: {
        textDocument: { synchronization: { dynamicRegistration: true, willSave: true, willSaveWaitUntil: true, didSave: true }, completion: { dynamicRegistration: true }, hover: { dynamicRegistration: true }, definition: { dynamicRegistration: true }, references: { dynamicRegistration: true }, documentSymbol: { dynamicRegistration: true }, diagnostic: { dynamicRegistration: true } },
        workspace: { symbol: { dynamicRegistration: true } },
      },
    })
    await this.sendNotification('initialized', {})
    this.initialized = true
  }

  private send(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.msgId
      this.pending.set(id, { resolve, reject })
      const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      const header = `Content-Length: ${Buffer.byteLength(msg, 'utf8')}\r\n\r\n`
      this.process?.stdin?.write(header + msg)
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`LSP request ${method} timed out`)) }
      }, 30000)
    })
  }

  private sendNotification(method: string, params?: any): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params })
    const header = `Content-Length: ${Buffer.byteLength(msg, 'utf8')}\r\n\r\n`
    this.process?.stdin?.write(header + msg)
  }

  private processResponseBuffer(): void {
    while (true) {
      if (this.contentLength === 0) {
        const match = this.buffer.match(/Content-Length: (\d+)\r\n/i)
        if (!match) break
        this.contentLength = parseInt(match[1])
        const headerEnd = this.buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) break
        this.buffer = this.buffer.slice(headerEnd + 4)
      }
      if (this.buffer.length < this.contentLength) break
      const content = this.buffer.slice(0, this.contentLength)
      this.buffer = this.buffer.slice(this.contentLength)
      this.contentLength = 0
      try {
        const msg = JSON.parse(content)
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) reject(new Error(msg.error.message))
          else resolve(msg.result)
        }
      } catch {}
    }
  }

  async openDocument(uri: string, language: string, text: string): Promise<void> {
    this.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId: language, version: 1, text } })
  }
  async changeDocument(uri: string, text: string, version: number): Promise<void> {
    this.sendNotification('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
  }
  async closeDocument(uri: string): Promise<void> {
    this.sendNotification('textDocument/didClose', { textDocument: { uri } })
  }
  async goToDefinition(uri: string, line: number, character: number): Promise<LSPLocation | null> {
    try { const r = await this.send('textDocument/definition', { textDocument: { uri }, position: { line, character } }); if (!r) return null; return Array.isArray(r) ? r[0] || null : r } catch { return null }
  }
  async findReferences(uri: string, line: number, character: number): Promise<LSPLocation[]> {
    try { const r = await this.send('textDocument/references', { textDocument: { uri }, position: { line, character }, context: { includeDeclaration: true } }); return r || [] } catch { return [] }
  }
  async hover(uri: string, line: number, character: number): Promise<LSPHover | null> {
    try { const r = await this.send('textDocument/hover', { textDocument: { uri }, position: { line, character } }); if (!r) return null; const contents = typeof r.contents === 'string' ? r.contents : r.contents?.[0]?.value || r.contents?.value || ''; return { contents, range: r.range } } catch { return null }
  }
  async documentSymbols(uri: string): Promise<LSPSymbol[]> {
    try { const r = await this.send('textDocument/documentSymbol', { textDocument: { uri } }); if (!r) return []; return r.map((s: any) => ({ name: s.name || '', kind: typeof s.kind === 'number' ? SYMBOL_KINDS[s.kind] || 'Unknown' : s.kind, range: s.range || s.location?.range, selectionRange: s.selectionRange || s.range })) } catch { return [] }
  }
  stop(): void { this.process?.kill(); this.process = null; this.initialized = false }
}

export const LSP_SERVER_CONFIGS: LSPServerConfig[] = [
  { name: 'TypeScript', command: 'typescript-language-server', args: ['--stdio'], language: 'typescript', extensions: ['.ts', '.tsx', '.js', '.jsx'] },
  { name: 'Python', command: 'pyright-langserver', args: ['--stdio'], language: 'python', extensions: ['.py'] },
  { name: 'Rust', command: 'rust-analyzer', args: [], language: 'rust', extensions: ['.rs'] },
  { name: 'Go', command: 'gopls', args: [], language: 'go', extensions: ['.go'] },
  { name: 'CSS', command: 'vscode-css-language-server', args: ['--stdio'], language: 'css', extensions: ['.css', '.scss', '.less'] },
  { name: 'HTML', command: 'vscode-html-language-server', args: ['--stdio'], language: 'html', extensions: ['.html'] },
  { name: 'JSON', command: 'vscode-json-language-server', args: ['--stdio'], language: 'json', extensions: ['.json'] },
]

export const getServerForFile = (filepath: string): LSPServerConfig | undefined =>
  LSP_SERVER_CONFIGS.find(s => s.extensions.some(ext => filepath.endsWith(ext)))

const clients = new Map<string, LSPClient>()

export const startServer = async (config: LSPServerConfig, projectUri: string): Promise<LSPClient> => {
  const existing = clients.get(config.name)
  if (existing) return existing
  const client = new LSPClient(config)
  await client.start(projectUri)
  clients.set(config.name, client)
  return client
}

export const stopAll = (): void => { for (const client of clients.values()) client.stop(); clients.clear() }
