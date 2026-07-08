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
  { id: 'deepseek', label: 'DeepSeek' },
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
      } else if (selectedProvider === 'deepseek') {
        url = 'https://api.deepseek.com/models'
        if (localKey) headers['Authorization'] = `Bearer ${localKey}`
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

      // For OpenRouter, verify the API key works by trying a minimal chat completion
      if (selectedProvider === 'openrouter' && localKey) {
        const testRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${localKey}`,
          },
          body: JSON.stringify({
            model: models[0],
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 1,
          }),
        })
        if (testRes.status === 401) throw new Error('Invalid API key: Unauthorized')
        if (testRes.status === 402) throw new Error('API key has insufficient credits')
      }
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
    if (id === 'llama') return (
      <svg viewBox="0 0 512 512" width="20" height="20" fill="#ff8236">
        <path d="m356.4 201.3-32.8 58.3c-43.3-33.3-107.4-38.2-150.7-2.4-69.8 57.6-64.9 190.8 43.7 191.6 30.4 0 56.2-14.3 83.9-23.8l14.6 58.1c-24.6 11.4-49.6 23.1-76.6 26.7-246 33.5-231.9-321.6-9.5-340.1 46.7-3.9 87.8 8.3 127.6 31.6zm-169.9-55.9c-37.4 11.2-72.2 31.8-98.5 60.8-4.9-58.8 8.3-177.7 73.7-201 9.7-3.4 43-11.9 42.1 5.3-1 17.3-24.1 46.9-29.7 63-9.7 28.2-.7 47.6 12.6 72.2zm92.4 252.8h-36.5v-41.3h-41.3v-34h37.7l3.6-3.6v-40.1h36.5V323h38.9v34h-38.9zm133.7-41.3v41.3h-36.5v-41.3h-38.9v-34h38.9v-43.8h36.5v40.1l3.6 3.6h37.7v34h-41.3zM305.4 31.4c4.9 7.3-22.6 38.7-27 46.7-12.6 23.8-4.1 37.4 5.3 60-27.5-4.1-53-.7-80.2 2.4C209.6 88.3 239 12.2 305.4 31.4"/>
      </svg>
    )
    if (id === 'ollama') return (
      <svg viewBox="0 0 1405 1857" width="20" height="20" fill="currentColor">
        <path d="M599.877 159.522c-17.333 2.8-38.133 11.866-52.8 23.066-44.4 33.734-78.8 105.334-93.333 194.534-5.467 33.733-9.2 80.533-9.2 116.266 0 42.134 4.933 96 12 133.201 1.6 8.266 2.4 15.599 1.733 16.133-.533.533-7.066 5.866-14.4 11.733-25.066 20-53.733 50.8-73.466 78.933-37.867 53.734-62.4 114.8-72.667 180.934-4 26.133-5.067 78.933-1.867 105.066 7.067 60.27 25.2 111.2 56.267 157.87l10.133 15.06-2.933 4.94c-20.8 34.93-38.533 85.46-46.8 134-6.533 38.4-7.333 48.66-7.333 100.13 0 51.87.666 62.13 6.8 98 7.333 42.93 22.266 88.4 38.933 118.67 5.467 9.86 18.8 30.4 20.4 31.46.533.27-1.067 5.2-3.6 10.94-19.2 42-35.6 97.86-42.4 144.93-4.8 32.27-5.466 42.67-5.466 76.67 0 43.33 2.4 64.4 11.466 98.93l1.333 5.07h57.057 57.2l-3.733-7.07c-23.067-42.67-25.2-121.87-5.333-200.93 9.067-36.54 19.334-63.34 38.534-100.27l11.466-22.4v-13.73c0-12.8-.266-14.27-4.4-22.67-3.2-6.4-7.466-11.87-15.066-19.33-12.934-12.54-22.267-25.74-29.734-42-32.8-71.2-39.2-176.94-16.133-267.07 9.6-37.6 25.467-71.07 42.133-89.33 11.334-12.54 17.2-26.54 17.2-41.07 0-15.07-5.333-27.47-17.333-40.4-34.4-36.8-55.6-81.6-63.2-133.73-10.8-74.272 8.8-155.205 53.333-219.338 43.6-62.934 104.8-103.334 173.2-114.133 15.334-2.534 44-2.134 60 .799 17.467 3.067 28.4 2.134 39.6-3.2 13.867-6.533 20.8-14.666 28.934-33.333 7.2-16.667 12.8-25.733 27.866-44.533 18.134-22.534 35.6-37.867 63.6-56.4 32-20.934 68.4-36.134 104.667-43.467 13.2-2.667 19.333-3.067 44-3.067s27.333.4 40.533 3.067c53.2 10.8 106 38.267 148.133 77.2 9.067 8.4 30.8 35.333 37.733 46.533 2.667 4.4 7.333 13.734 10.267 20.667 8.133 18.667 15.067 26.8 28.934 33.333 10.8 5.2 22.133 6.267 38.933 3.467 26.54-4.533 46.94-4.133 72.94 1.2 88.53 17.867 165.6 90.8 199.73 188.533 29.73 85.734 21.33 175.474-22.93 244.004-7.47 11.6-14.94 20.933-25.74 32.4-23.33 24.93-23.33 55.87-.13 81.47 38.13 41.73 62 144.4 54.8 234.93-4.8 59.73-20.13 113.2-41.2 143.47-3.73 5.33-11.47 14.4-17.33 20-7.6 7.46-11.87 12.93-15.07 19.33-4.13 8.4-4.4 9.87-4.4 22.67v13.73l11.47 22.4c19.2 36.93 29.46 63.73 38.53 100.27 19.6 78 17.87 155.6-4.53 199.73-1.87 3.73-3.47 7.2-3.47 7.6 0 .4 25.47.67 56.67.67h56.53l1.47-5.74c.8-3.06 2.13-7.73 2.8-10.4 1.46-5.86 4.4-23.2 6.8-39.86 2.26-16.8 2.26-78.67-.02-97.34-8.54-67.73-22.8-121.46-46.14-172.26-2.53-5.74-4.13-10.67-3.6-10.94.67-.4 4.4-5.73 8.4-11.73 29.07-44 46.94-99.33 56-172.4 2.4-20.13 2.4-106.67 0-126-6.4-49.87-14.13-83.73-26.93-118-5.33-14.27-19.47-44.4-25.47-54.13l-2.93-4.94 10.13-15.06c31.07-46.67 49.2-97.6 56.27-157.87 3.2-26.13 2.13-78.93-1.87-105.066-10.4-66.267-34.8-127.067-72.67-180.934-19.74-28.133-48.4-58.933-73.46-78.933-7.33-5.867-13.87-11.2-14.4-11.733-.67-.534.13-7.867 1.73-16.133 16.14-84.084 15.6-189.017-1.33-271.017-14.67-71.467-41.33-128.267-75.73-161.067-27.47-26.133-55.47-37.333-89.07-35.2-77.07 4.533-139.2 93.2-163.73 232.933-4 22.534-7.47 48.934-7.47 56.134 0 2.8-.53 5.066-1.2 5.066-.67 0-5.87-2.666-11.47-6-59.46-35.2-125.6-54-190-54s-130.533 18.8-190 54c-5.6 3.334-10.8 6-11.467 6-.666 0-1.2-2.266-1.2-5.066 0-7.467-3.6-34.667-7.466-56.134-22.267-125.466-73.334-208.533-141.2-229.466-9.334-2.8-35.867-4.667-45.334-3.2zM622.544 268.055c19.2 15.2 40.533 58.667 52.8 107.333 2.267 8.8 4.667 18.934 5.333 22.667.534 3.6 2 11.733 3.2 18 5.2 28.267 7.6 58.8 7.867 96l.133 36.667-9.2 13.6-9.2 13.733h-21.466c-25.067 0-50 3.2-73.867 9.6-8.533 2.133-16.8 4.267-18.4 4.667-2.533.533-2.933-.267-4.4-11.2-7.867-59.334-7.467-125.067 1.2-179.734 9.6-60.933 32-116.133 53.868-132.4 5.2-3.866 6.133-3.733 12.132 1.067zM1382.81 267.122c13.2 9.733 27.73 35.6 38.53 68.666 21.74 66.134 27.87 156.934 16.4 243.334-1.46 10.933-1.86 11.733-4.4 11.2-1.6-.4-9.86-2.534-18.4-4.667-23.86-6.4-48.8-9.6-73.86-9.6h-21.47l-9.2-13.733-9.2-13.6.13-36.667c.27-51.733 5.07-92.133 16.54-137.067 12.13-48.267 33.6-91.733 52.66-106.933 6-4.8 6.94-4.933 12.27-.933z"/>
      </svg>
    )
    if (id === 'gemini') return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
    )
    if (id === 'openai') return (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/>
      </svg>
    )
    if (id === 'deepseek') return (
      <svg viewBox="0 0 377.1 277.86" width="20" height="20" fill="#4d6bfe">
        <path d="M373.15,23.32c-4-1.95-5.72,1.77-8.06,3.66-.79.62-1.47,1.43-2.14,2.14-5.85,6.26-12.67,10.36-21.57,9.86-13.04-.71-24.16,3.38-33.99,13.37-2.09-12.31-9.04-19.66-19.6-24.38-5.54-2.45-11.13-4.9-14.99-10.23-2.71-3.78-3.44-8-4.81-12.16-.85-2.51-1.72-5.09-4.6-5.52-3.13-.5-4.36,2.14-5.58,4.34-4.93,8.99-6.82,18.92-6.65,28.97.43,22.58,9.97,40.56,28.89,53.37,2.16,1.46,2.71,2.95,2.03,5.09-1.29,4.4-2.82,8.68-4.19,13.09-.85,2.82-2.14,3.44-5.15,2.2-10.39-4.34-19.37-10.76-27.29-18.55-13.46-13.02-25.63-27.41-40.81-38.67-3.57-2.64-7.12-5.09-10.81-7.41-15.49-15.07,2.03-27.45,6.08-28.9,4.25-1.52,1.47-6.79-12.23-6.73-13.69.06-26.24,4.65-42.21,10.76-2.34.93-4.79,1.61-7.32,2.14-14.5-2.73-29.55-3.35-45.29-1.58-29.62,3.32-53.28,17.34-70.68,41.28C1.29,88.2-3.63,120.88,2.39,155c6.33,35.91,24.64,65.68,52.8,88.94,29.18,24.1,62.8,35.91,101.15,33.65,23.29-1.33,49.23-4.46,78.48-29.24,7.38,3.66,15.12,5.12,27.97,6.23,9.89.93,19.41-.5,26.79-2.02,11.55-2.45,10.75-13.15,6.58-15.13-33.87-15.78-26.44-9.36-33.2-14.54,17.21-20.41,43.15-41.59,53.3-110.19.79-5.46.11-8.87,0-13.3-.06-2.67.54-3.72,3.61-4.03,8.48-.96,16.72-3.29,24.28-7.47,21.94-12,30.78-31.69,32.87-55.33.31-3.6-.06-7.35-3.86-9.24ZM181.96,235.97c-32.83-25.83-48.74-34.33-55.31-33.96-6.14.34-5.04,7.38-3.69,11.97,1.41,4.53,3.26,7.66,5.85,11.63,1.78,2.64,3.01,6.57-1.78,9.49-10.57,6.58-28.95-2.2-29.82-2.64-21.38-12.59-39.26-29.24-51.87-52.01-12.16-21.92-19.23-45.43-20.39-70.52-.31-6.08,1.47-8.22,7.49-9.3,7.92-1.46,16.11-1.77,24.03-.62,33.49,4.9,62.01,19.91,85.9,43.63,13.65,13.55,23.97,29.71,34.61,45.49,11.3,16.78,23.48,32.75,38.97,45.84,5.46,4.59,9.83,8.09,14,10.67-12.59,1.4-33.62,1.71-47.99-9.68ZM197.69,134.65c0-2.7,2.15-4.84,4.87-4.84.6,0,1.16.12,1.66.31.67.25,1.29.62,1.77,1.18.87.84,1.36,2.08,1.36,3.35,0,2.7-2.15,4.84-4.85,4.84s-4.81-2.14-4.81-4.84ZM246.55,159.77c-3.13,1.27-6.26,2.39-9.27,2.51-4.67.22-9.77-1.68-12.55-4-4.3-3.6-7.36-5.61-8.67-11.94-.54-2.7-.23-6.85.25-9.24,1.12-5.15-.12-8.44-3.74-11.44-2.96-2.45-6.7-3.1-10.82-3.1-1.54,0-2.95-.68-4-1.24-1.72-.87-3.13-3.01-1.78-5.64.43-.84,2.53-2.92,3.02-3.29,5.58-3.19,12.03-2.14,18,.25,5.54,2.26,9.71,6.42,15.72,12.28,6.16,7.1,7.26,9.09,10.76,14.39,2.76,4.19,5.29,8.47,7.01,13.37,1.04,3.04-.31,5.55-3.94,7.1Z"/>
      </svg>
    )
    if (id === 'openrouter') return (
      <svg viewBox="0 0 512 512" width="20" height="20" fill="currentColor">
        <path d="M3 248.945C18 248.945 76 236 106 219C136 202 136 202 198 158 276.497 102.293 332 120.945 423 120.945" stroke="currentColor" strokeWidth={90} fill="none"/>
        <path d="M511 121.5L357.25 210.268V32.7324L511 121.5Z"/>
        <path d="M0 249C15 249 73 261.945 103 278.945C133 295.945 133 295.945 195 339.945C273.497 395.652 329 377 420 377" stroke="currentColor" strokeWidth={90} fill="none"/>
        <path d="M508 376.445L354.25 287.678V465.213L508 376.445Z"/>
      </svg>
    )
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
              setLocalUrl(p.id === 'llama' ? 'http://localhost:8080/' : p.id === 'ollama' ? 'http://127.0.0.1:11434' : p.id === 'deepseek' ? 'https://api.deepseek.com' : '');
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
          <div style={{ fontSize: 'var(--font-sm)', color: '#f87171', maxWidth: '90%', wordBreak: 'break-word' }}>
            {updateStatus.message || 'Update check failed'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => { setChecking(true); window.electronAPI?.checkForUpdate() }}
              style={{ padding: '10px 20px', borderRadius: 8, border: '1px solid #555', background: 'transparent', color: '#ccc', cursor: 'pointer', fontSize: 'var(--font-md)', fontFamily: 'inherit' }}>
              Retry
            </button>
            <button onClick={() => window.open('https://github.com/YASSER-27/Bowow/releases/latest', '_blank')}
              style={{ padding: '10px 20px', borderRadius: 8, border: 'none', background: '#4ade80', color: '#000', cursor: 'pointer', fontSize: 'var(--font-md)', fontFamily: 'inherit', fontWeight: 600 }}>
              Download from GitHub
            </button>
          </div>
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
