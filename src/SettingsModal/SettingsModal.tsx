import { useState, useRef, useMemo, useEffect } from 'react'
import { useAppStore, PROVIDER_CONFIGS } from '../store'
import { ApiProvider } from '../types'
import type { CommandPermission, TerminalPermissionEntry, McpServer, UpdateStatus } from '../types'
import yasserPic from '../assets/yasser.jpg'
import bowowWav from '../assets/Bowow.wav'
import './SettingsModal.css'

interface Props {
  onClose: () => void
  inline?: boolean
}

type SettingsTab = 'api' | 'systemPrompt' | 'mcp' | 'terminal' | 'info' | 'update'

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'api', label: 'API Settings' },
  { id: 'systemPrompt', label: 'System Prompt' },
  { id: 'mcp', label: 'MCP Server' },
  { id: 'terminal', label: 'Terminal Commands' },
  { id: 'info', label: 'Info' },
  { id: 'update', label: 'Update' },
]

const PROVIDERS: { id: ApiProvider; label: string }[] = [
  { id: 'llama', label: 'llama.cpp' },
  { id: 'ollama', label: 'Ollama' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
]

export default function SettingsModal({ onClose, inline }: Props) {
  const apiSettings = useAppStore(s => s.apiSettings)
  const setApiProvider = useAppStore(s => s.setApiProvider)
  const setApiBaseUrl = useAppStore(s => s.setApiBaseUrl)
  const setApiModel = useAppStore(s => s.setApiModel)
  const setApiKey = useAppStore(s => s.setApiKey)
  const setApiConnected = useAppStore(s => s.setApiConnected)
  const setApiDisableReasoning = useAppStore(s => s.setApiDisableReasoning)
  const setApiGamePrompt = useAppStore(s => s.setApiGamePrompt)
  const setFavoriteModels = useAppStore(s => s.setFavoriteModels)
  const setAvailableModels = useAppStore(s => s.setAvailableModels)

  const storeTerminalPermissions = useAppStore(s => s.terminalPermissions)
  const storeUserPrompts = useAppStore(s => s.userPrompts)
  const storeMcpServers = useAppStore(s => s.mcpServers)
  const storeSystemPrompt = useAppStore(s => s.systemPrompt)
  const setTerminalPermissions = useAppStore(s => s.setTerminalPermissions)
  const setUserPrompts = useAppStore(s => s.setUserPrompts)
  const removeUserPrompt = useAppStore(s => s.removeUserPrompt)
  const addMcpServer = useAppStore(s => s.addMcpServer)
  const removeMcpServer = useAppStore(s => s.removeMcpServer)
  const setSystemPrompt = useAppStore(s => s.setSystemPrompt)

  const [activeTab, setActiveTab] = useState<SettingsTab>('api')

  // API settings state
  const [selectedProvider, setSelectedProvider] = useState<ApiProvider>(apiSettings.provider)
  const [localUrl, setLocalUrl] = useState(apiSettings.baseUrl)
  const [localKey, setLocalKey] = useState(apiSettings.apiKeys[selectedProvider] || '')
  const [localModel, setLocalModel] = useState(apiSettings.model)
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  const [connecting, setConnecting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [connectError, setConnectError] = useState('')
  const [saved, setSaved] = useState(false)
  const [modelSearch, setModelSearch] = useState('')
  const [scanResults, setScanResults] = useState<Record<string, { ms: number; error?: string }>>({})
  const [scanning, setScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState(0)

  // System prompt state
  const [localSystemPrompt, setLocalSystemPrompt] = useState(storeSystemPrompt)
  const [newUserPrompt, setNewUserPrompt] = useState('')
  const [localUserPrompts, setLocalUserPrompts] = useState<string[]>(storeUserPrompts)

  // Terminal commands state
  const [localTerminalPerms, setLocalTerminalPerms] = useState<TerminalPermissionEntry[]>(storeTerminalPermissions)
  const [newTermCmd, setNewTermCmd] = useState('')

  // MCP servers state
  const [localMcpServers, setLocalMcpServers] = useState<McpServer[]>(storeMcpServers)
  const [newMcpName, setNewMcpName] = useState('')
  const [newMcpUrl, setNewMcpUrl] = useState('')
  const [newMcpTools, setNewMcpTools] = useState('')

  const favorites = useMemo(() => apiSettings.favoriteModels || [], [apiSettings.favoriteModels])
  const filteredFavorites = useMemo(
    () => fetchedModels.length > 0 ? favorites.filter(f => fetchedModels.includes(f)) : [],
    [fetchedModels, favorites]
  )

  useEffect(() => {
    if (apiSettings.connected) {
      handleConnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEsc)
    return () => window.removeEventListener('keydown', handleEsc)
  }, [onClose])

  const toggleFavorite = (model: string) => {
    const next = favorites.includes(model) ? favorites.filter(m => m !== model) : [...favorites, model]
    setFavoriteModels(next)
  }

  const handleScanModels = async () => {
    const api = window.electronAPI
    if (!api?.scanModel) return
    setScanning(true)
    setScanResults({})
    setScanProgress(0)
    const results: Record<string, { ms: number; error?: string }> = {}
    let completed = 0
    const concurrency = 2
    const queue = [...fetchedModels]
    const workers: Promise<void>[] = []
    for (let i = 0; i < concurrency; i++) {
      workers.push((async () => {
        while (queue.length > 0) {
          const model = queue.shift()!
          const result = await api.scanModel!({
            provider: selectedProvider, model, localUrl, localKey,
          })
          results[model] = result
          completed++
          setScanProgress(completed)
          setScanResults({ ...results })
        }
      })())
    }
    await Promise.all(workers)
    setScanning(false)
  }

  const isLocal = selectedProvider === 'llama' || selectedProvider === 'ollama'
  const isCloud = !isLocal

  const handleConnect = async () => {
    setConnecting(true)
    setConnectError('')
    setFetchedModels([])
    setConnected(false)
    setScanResults({})
    try {
      let url = ''
      const headers: Record<string, string> = {}
      if (selectedProvider === 'llama') {
        url = localUrl.replace(/\/+$/, '')
      } else if (selectedProvider === 'ollama') {
        url = `${localUrl.replace(/\/+$/, '')}/api/tags`
      } else if (selectedProvider === 'openai') {
        url = 'https://api.openai.com/v1/models'
        if (localKey) headers['Authorization'] = `Bearer ${localKey}`
      } else if (selectedProvider === 'openrouter') {
        url = 'https://openrouter.ai/api/v1/models'
        if (localKey) headers['Authorization'] = `Bearer ${localKey}`
      } else if (selectedProvider === 'gemini') {
        url = 'https://generativelanguage.googleapis.com/v1beta/models'
        if (localKey) headers['x-goog-api-key'] = localKey
      }
      if (!url) throw new Error('No URL configured')
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`Connection failed: ${res.status} ${res.statusText}`)
      let models: string[] = []
      try {
        const data = await res.json()
        models = data.data?.map((m: any) => {
          const name = m.id || m.name || ''
          return selectedProvider === 'gemini' ? name.replace(/^models\//, '') : name
        }) || data.models?.map((m: any) => {
          const name = m.name || m.model || ''
          return selectedProvider === 'gemini' ? name.replace(/^models\//, '') : name
        }) || []
      } catch (jsonErr) {
        if (selectedProvider === 'llama') {
          models = ['DeepSeek.gguf']
        } else {
          throw jsonErr
        }
      }
      if (models.length === 0) throw new Error('No models found')
      setFetchedModels(models)
      setAvailableModels(models)
      setConnected(true)
      setApiConnected(true)
      setLocalModel(models[0])
    } catch (err: any) {
      setConnectError(err.message || 'Connection failed')
    }
    setConnecting(false)
  }

  const handleDone = () => {
    setApiProvider(selectedProvider)
    setApiBaseUrl(localUrl)
    setApiKey(localKey)
    setApiModel(localModel)
    setApiDisableReasoning(false)
    setSystemPrompt(localSystemPrompt)
    setUserPrompts(localUserPrompts)
    setTerminalPermissions(localTerminalPerms)
    localMcpServers.forEach(s => addMcpServer(s))
    setSaved(true)
    setTimeout(onClose, 400)
  }

  const providerIcon = (id: ApiProvider) => {
    if (id === 'llama') return <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15l-5-5 1.41-1.41L11 14.17l6.59-6.59L19 9l-8 8z"/></svg>
    if (id === 'ollama') return <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
    if (id === 'gemini') return <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
    if (id === 'openai') return <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>
    return <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
  }

  const renderApiSettings = () => (
    <>
      <label className="import-field-label">Provider</label>
      <div className="settings-provider-grid">
        {PROVIDERS.map(p => (
          <button key={p.id}
            onClick={() => {
              setSelectedProvider(p.id);
              setConnected(false);
              setFetchedModels([]);
              setConnectError('');
              setApiConnected(false);
              setScanResults({});
              setLocalUrl(p.id === 'llama' ? 'http://localhost:8080/' : (p.id === 'ollama' ? 'http://127.0.0.1:11434' : ''));
              setLocalKey(apiSettings.apiKeys[p.id] || '');
            }}
            className={`settings-provider-btn${selectedProvider === p.id ? ' active' : ''}`}
          >
            {providerIcon(p.id)}
            <span>{p.label}</span>
          </button>
        ))}
      </div>
      <div style={{ height: 1, background: '#2a2a2a', margin: '8px 0' }} />
      {isLocal ? (
        <div className="import-field">
          <label className="import-field-label">Base URL</label>
          <input className="import-name-input" value={localUrl}
            onChange={e => { setLocalUrl(e.target.value); setConnected(false); setFetchedModels([]); setConnectError('') }}
            placeholder="http://localhost:8080/" />
        </div>
      ) : (
        <div className="import-field">
          <label className="import-field-label">API Key</label>
          <input className="import-name-input" value={localKey}
            onChange={e => { setLocalKey(e.target.value); setConnected(false); setFetchedModels([]); setConnectError(''); setScanResults({}) }}
            placeholder="sk-..." type="password" />
          {filteredFavorites.length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 'var(--font-xs)', color: '#777', fontWeight: 600 }}>Favorites:</span>
              {filteredFavorites.map(f => {
                const result = scanResults[f]
                const grade = result && !result.error
                  ? result.ms <= 2000 ? 'good' : result.ms <= 6000 ? 'medium' : 'bad'
                  : null
                const borderColor = grade === 'good' ? '#4ade80' : grade === 'medium' ? '#facc15' : grade === 'bad' ? '#f87171' : '#444'
                const bgColor = grade === 'good' ? 'rgba(74,222,128,0.15)' : grade === 'medium' ? 'rgba(250,204,21,0.15)' : grade === 'bad' ? 'rgba(248,113,113,0.15)' : '#222'
                return (
                  <span key={f} onClick={() => { setLocalModel(f); setApiModel(f) }}
                    style={{
                      fontSize: 'var(--font-xs)', padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
                      background: localModel === f ? bgColor : '#222',
                      color: localModel === f ? '#fff' : '#e0e0e0',
                      fontWeight: 500,
                      border: grade ? `1px solid ${borderColor}` : (localModel === f ? '1px solid #888' : '1px solid #444'),
                    }}>{f}</span>
                )
              })}
            </div>
          )}
        </div>
      )}
      {!connected && (
        <button onClick={handleConnect} disabled={connecting || (isCloud && !localKey)}
          className="settings-connect-btn">
          {connecting ? 'Connecting...' : 'Connect'}
        </button>
      )}
      {connectError && (
        <div className="settings-error">{connectError}</div>
      )}
      {connected && fetchedModels.length > 0 && (
        <>
          <div style={{ height: 1, background: '#2a2a2a', margin: '8px 0' }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <label className="import-field-label" style={{ margin: 0 }}>Select Model ({fetchedModels.length} available)</label>
            <button onClick={handleScanModels} disabled={scanning}
              style={{
                background: scanning ? '#333' : 'transparent',
                border: '1px solid #555', borderRadius: 6,
                color: scanning ? '#888' : '#ccc',
                padding: '4px 10px', fontSize: 'var(--font-xs)', cursor: scanning ? 'wait' : 'pointer',
                fontFamily: 'inherit', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4,
              }}>
              {scanning ? `Scanning ${scanProgress}/${fetchedModels.length}` : 'Scan All'}
            </button>
          </div>
          <input className="import-name-input" value={modelSearch}
            onChange={e => setModelSearch(e.target.value)}
            placeholder="Search models..." style={{ marginBottom: 6, fontSize: 'var(--font-md)', padding: '8px 10px' }} />
          <div className="settings-model-list">
            {fetchedModels.filter(m => m.toLowerCase().includes(modelSearch.toLowerCase())).map(m => {
              const result = scanResults[m]
              const grade = result && !result.error
                ? result.ms <= 2000 ? 'good' : result.ms <= 6000 ? 'medium' : 'bad'
                : null
              return (
                <button key={m} onClick={() => setLocalModel(m)}
                  className={`settings-model-chip${localModel === m ? ' active' : ''}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span onClick={e => { e.stopPropagation(); toggleFavorite(m) }}
                    style={{ cursor: 'pointer', marginRight: 4, color: favorites.includes(m) ? '#ffd700' : '#555', fontSize: 'var(--font-md)', userSelect: 'none' }}>
                    {favorites.includes(m) ? '★' : '☆'}
                  </span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m}</span>
                  {scanning && !result && <span className="thinking-shimmer" style={{ fontSize: 'var(--font-xxs)', marginLeft: 4, flexShrink: 0 }}>...</span>}
                  {result && (
                    <span style={{
                      marginLeft: 4, fontSize: 'var(--font-xs)', display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0,
                      color: result.error ? '#f87171' : grade === 'good' ? '#4ade80' : grade === 'medium' ? '#facc15' : '#f87171',
                    }}>
                      {result.error ? `! ${result.error}` : `${result.ms}ms`}
                      {!result.error && (
                        <span style={{
                          fontSize: 'var(--font-xxs)', padding: '1px 5px', borderRadius: 3, border: 'none',
                          background: grade === 'good' ? 'rgba(74,222,128,0.2)' : grade === 'medium' ? 'rgba(250,204,21,0.2)' : 'rgba(248,113,113,0.2)',
                          fontWeight: 600,
                        }}>
                          {grade === 'good' ? 'Good' : grade === 'medium' ? 'Med' : 'Bad'}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}
    </>
  )

  const renderSystemPrompt = () => (
    <>
      <label className="import-field-label">System Prompt</label>
      <textarea className="import-name-input" value={localSystemPrompt}
        onChange={e => setLocalSystemPrompt(e.target.value)}
        placeholder="Enter system prompt for the AI agent..."
        style={{ minHeight: 100, resize: 'vertical', fontFamily: 'monospace', fontSize: 'var(--font-sm)', lineHeight: 1.5, marginBottom: 0 }} />
      <div style={{ height: 1, background: '#2a2a2a', margin: '12px 0' }} />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label className="import-field-label" style={{ margin: 0 }}>User Prompts</label>
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="import-name-input" value={newUserPrompt}
            onChange={e => setNewUserPrompt(e.target.value)}
            placeholder="Enter prompt template..."
            style={{ width: 200, fontSize: 'var(--font-sm)', padding: '6px 8px', margin: 0 }} />
          <button onClick={() => {
            if (newUserPrompt.trim()) {
              setLocalUserPrompts([...localUserPrompts, newUserPrompt.trim()])
              setNewUserPrompt('')
            }
          }}
            style={{
              padding: '4px 12px', borderRadius: 6, border: '1px solid #555',
              background: 'transparent', color: '#ccc', cursor: 'pointer',
              fontSize: 'var(--font-sm)', fontFamily: 'inherit', whiteSpace: 'nowrap',
            }}>+New</button>
        </div>
      </div>
      {localUserPrompts.length === 0 && (
        <div style={{ fontSize: 'var(--font-sm)', color: '#555', padding: '12px 0' }}>
          No saved user prompts. Add one above to quickly insert into your conversation.
        </div>
      )}
      {localUserPrompts.map((p, i) => (
        <div key={i} className="prompt-row">
          <span className="prompt-row-text">{p}</span>
          <button className="icon-btn" onClick={() => {
            setLocalUserPrompts(localUserPrompts.filter((_, idx) => idx !== i))
          }} style={{ color: '#f87171' }}>x</button>
        </div>
      ))}
    </>
  )

  const setPerm = (index: number, perm: CommandPermission) => {
    const next = [...localTerminalPerms]
    next[index] = { ...next[index], permission: perm }
    setLocalTerminalPerms(next)
  }

  const renderTerminalCommands = () => (
    <>
      <label className="import-field-label">Allow / Ask / Deny</label>
      <div style={{ fontSize: 'var(--font-xs)', color: '#666', lineHeight: 1.4, marginBottom: 8 }}>
        Control which terminal commands the agent can execute. 'Allow' lets it run freely,
        'Ask' prompts you before execution, 'Deny' blocks the command entirely.
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <input className="import-name-input" value={newTermCmd}
          onChange={e => setNewTermCmd(e.target.value)}
          placeholder="e.g. Remove-Item, npm run, Get-ChildItem..."
          style={{ fontSize: 'var(--font-sm)', padding: '6px 8px', fontFamily: 'monospace', margin: 0, flex: 1 }}
          onKeyDown={e => {
            if (e.key === 'Enter' && newTermCmd.trim()) {
              setLocalTerminalPerms([...localTerminalPerms, { command: newTermCmd.trim(), permission: 'ask' }])
              setNewTermCmd('')
            }
          }} />
        <button onClick={() => {
          if (newTermCmd.trim()) {
            setLocalTerminalPerms([...localTerminalPerms, { command: newTermCmd.trim(), permission: 'ask' }])
            setNewTermCmd('')
          }
        }}
          style={{
            padding: '4px 12px', borderRadius: 6, border: '1px solid #555',
            background: 'transparent', color: '#ccc', cursor: 'pointer',
            fontSize: 'var(--font-sm)', fontFamily: 'inherit', whiteSpace: 'nowrap',
          }}>Add</button>
      </div>
      {localTerminalPerms.length === 0 && (
        <div style={{ fontSize: 'var(--font-sm)', color: '#555', padding: '12px 0' }}>
          No command rules configured. Add a command above to restrict its usage.
        </div>
      )}
      {localTerminalPerms.map((entry, i) => (
        <div key={i} className="perm-row">
          <span className="perm-row-code">{entry.command}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div className="perm-pills">
              {(['allow', 'ask', 'deny'] as CommandPermission[]).map(p => (
                <button key={p} onClick={() => setPerm(i, p)}
                  className={`perm-pill${entry.permission === p ? ` active-${p}` : ''}`}>
                  {p}
                </button>
              ))}
            </div>
            <button className="icon-btn" onClick={() => {
              setLocalTerminalPerms(localTerminalPerms.filter((_, idx) => idx !== i))
            }} style={{ color: '#f87171' }}>x</button>
          </div>
        </div>
      ))}
    </>
  )

  const renderMcpServer = () => (
    <>
      <label className="import-field-label">MCP Tools</label>
      <div style={{ fontSize: 'var(--font-xs)', color: '#666', lineHeight: 1.4, marginBottom: 8 }}>
        External tools the agent can call via Model Context Protocol. Add a server name, URL, and comma-separated tool names.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12, padding: 10, background: '#111', borderRadius: 8, border: '1px solid #222' }}>
        <input className="import-name-input" value={newMcpName}
          onChange={e => setNewMcpName(e.target.value)}
          placeholder="Server name..."
          style={{ fontSize: 'var(--font-sm)', padding: '6px 8px', margin: 0 }} />
        <input className="import-name-input" value={newMcpUrl}
          onChange={e => setNewMcpUrl(e.target.value)}
          placeholder="URL or path..."
          style={{ fontSize: 'var(--font-sm)', padding: '6px 8px', margin: 0 }} />
        <div style={{ display: 'flex', gap: 6 }}>
          <input className="import-name-input" value={newMcpTools}
            onChange={e => setNewMcpTools(e.target.value)}
            placeholder="Tool names (comma separated)..."
            style={{ fontSize: 'var(--font-sm)', padding: '6px 8px', margin: 0, flex: 1 }} />
          <button onClick={() => {
            if (newMcpName.trim() && newMcpUrl.trim()) {
              setLocalMcpServers([...localMcpServers, {
                name: newMcpName.trim(),
                url: newMcpUrl.trim(),
                tools: newMcpTools.split(',').map(t => t.trim()).filter(Boolean),
              }])
              setNewMcpName('')
              setNewMcpUrl('')
              setNewMcpTools('')
            }
          }}
            style={{
              padding: '4px 12px', borderRadius: 6, border: '1px solid #555',
              background: 'transparent', color: '#ccc', cursor: 'pointer',
              fontSize: 'var(--font-sm)', fontFamily: 'inherit', whiteSpace: 'nowrap',
            }}>Add Server</button>
        </div>
      </div>
      {localMcpServers.length === 0 && (
        <div style={{ fontSize: 'var(--font-sm)', color: '#555', padding: '12px 0' }}>
          No MCP servers configured. Add one above to extend the agent's capabilities.
        </div>
      )}
      {localMcpServers.map((s, i) => (
        <div key={i} className="mcp-row">
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ fontSize: 'var(--font-md)', color: '#e0e0e0', fontWeight: 600 }}>{s.name}</div>
            <div style={{ fontSize: 'var(--font-xs)', color: '#666' }}>{s.url}</div>
            {s.tools.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {s.tools.map((t, ti) => (
                  <span key={ti} style={{ fontSize: 'var(--font-xxs)', padding: '1px 6px', borderRadius: 3, background: '#222', border: '1px solid #333', color: '#888' }}>{t}</span>
                ))}
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={() => {
            setLocalMcpServers(localMcpServers.filter((_, idx) => idx !== i))
          }} style={{ color: '#f87171' }}>x</button>
        </div>
      ))}
    </>
  )

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    window.electronAPI?.onUpdateStatus((status) => {
      setUpdateStatus(status)
      if (status.status !== 'checking') setChecking(false)
    })
  }, [])

  const renderUpdate = () => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 16, padding: '30px 0' }}>
      <div style={{ fontSize: 'var(--font-xl)', fontWeight: 700, color: '#888' }}>Update</div>
      <div style={{ fontSize: 'var(--font-md)', color: '#666', lineHeight: 1.6 }}>
        Check for new versions of Bowow.
      </div>
      {!updateStatus && !checking && (
        <button onClick={() => { setChecking(true); window.electronAPI?.checkForUpdate() }}
          style={{ padding: '10px 32px', borderRadius: 8, border: '1px solid #555', background: 'transparent', color: '#ccc', cursor: 'pointer', fontSize: 'var(--font-md)', fontFamily: 'inherit' }}>
          Check for Updates
        </button>
      )}
      {checking && (
        <div style={{ fontSize: 'var(--font-sm)', color: '#888' }}>Checking for updates...</div>
      )}
      {updateStatus?.status === 'not-available' && (
        <div style={{ fontSize: 'var(--font-sm)', color: '#4ade80' }}>You have the latest version.</div>
      )}
      {updateStatus?.status === 'available' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 'var(--font-sm)', color: '#888' }}>
            Version {updateStatus.version} available
          </div>
          <button onClick={() => window.electronAPI?.downloadUpdate()}
            style={{ padding: '10px 32px', borderRadius: 8, border: 'none', background: '#4ade80', color: '#000', cursor: 'pointer', fontSize: 'var(--font-md)', fontFamily: 'inherit', fontWeight: 600 }}>
            Download
          </button>
        </div>
      )}
      {updateStatus?.status === 'downloading' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: '80%' }}>
          <div style={{ fontSize: 'var(--font-sm)', color: '#888' }}>Downloading... {Math.round(updateStatus.percent || 0)}%</div>
          <div style={{ width: '100%', height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${updateStatus.percent || 0}%`, height: '100%', background: '#4ade80', borderRadius: 3, transition: 'width 0.3s' }} />
          </div>
        </div>
      )}
      {updateStatus?.status === 'downloaded' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 'var(--font-sm)', color: '#4ade80' }}>Downloaded v{updateStatus.version}</div>
          <button onClick={() => window.electronAPI?.installUpdate()}
            style={{ padding: '10px 32px', borderRadius: 8, border: 'none', background: '#4ade80', color: '#000', cursor: 'pointer', fontSize: 'var(--font-md)', fontFamily: 'inherit', fontWeight: 600 }}>
            Restart & Install
          </button>
        </div>
      )}
      {updateStatus?.status === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{ fontSize: 'var(--font-sm)', color: '#f87171' }}>
            {updateStatus.message || 'Update check failed'}
          </div>
          <button onClick={() => { setChecking(true); window.electronAPI?.checkForUpdate() }}
            style={{ padding: '10px 32px', borderRadius: 8, border: '1px solid #555', background: 'transparent', color: '#ccc', cursor: 'pointer', fontSize: 'var(--font-md)', fontFamily: 'inherit' }}>
            Retry
          </button>
        </div>
      )}
    </div>
  )

  const renderInfo = () => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 16, padding: '20px 0' }}>
      <img src={yasserPic} alt="Yasser" draggable={false}
        style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', border: '2px solid #888' }} />
      <div>
        <div onClick={() => audioRef.current?.play()}
          style={{ fontWeight: 700, fontSize: 'var(--font-xl)', marginBottom: 4, cursor: 'pointer',
            background: 'linear-gradient(90deg, #555, #e0e0e0, #555)', backgroundSize: '200% 100%',
            WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
            animation: 'shimmer 2s infinite linear',
          }}>Bowow Beta</div>
        <div style={{ fontSize: 'var(--font-md)', color: '#888', lineHeight: 1.6 }}>
          creates and edits files automatically.
        </div>
      </div>
      <div style={{ fontSize: 'var(--font-md)', color: '#666', lineHeight: 1.6 }}>
        Built by <a href="https://github.com/YASSER-27" target="_blank" rel="noopener noreferrer"
          style={{ color: '#999', textDecoration: 'none' }}>YASSER-27</a>
      </div>
      <div style={{ fontSize: 'var(--font-xs)', color: '#555' }}>
        Sponsor this project
      </div>
      <audio ref={audioRef} src={bowowWav} />
    </div>
  )

  return (
    <div className="import-overlay" onClick={onClose} style={inline ? { position: 'absolute', inset: 0, background: '#121212', zIndex: 1 } : undefined}>
      <div className="settings-modal" onClick={e => e.stopPropagation()} style={inline ? { width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none', borderRadius: 0, border: 'none', boxShadow: 'none' } : undefined}>
        <div className="import-header">
          <h2 className="import-title">Settings</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="import-close" onClick={onClose}>x</button>
          </div>
        </div>
        <div className="settings-layout">
          <div className="settings-nav">
            {TABS.map(tab => (
              <button key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`settings-nav-btn${activeTab === tab.id ? ' active' : ''}`}>
                {tab.label}
              </button>
            ))}
          </div>
          <div className="settings-content">
            {activeTab === 'api' && renderApiSettings()}
            {activeTab === 'systemPrompt' && renderSystemPrompt()}
            {activeTab === 'terminal' && renderTerminalCommands()}
            {activeTab === 'mcp' && renderMcpServer()}
            {activeTab === 'info' && renderInfo()}
            {activeTab === 'update' && renderUpdate()}
          </div>
        </div>
        <div className="import-footer">
          <button onClick={handleDone} className="settings-done-btn">
            {saved ? 'Saved!' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  )
}
