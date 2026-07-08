import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { BuildData, BuildTimelineItem, CanvasElement, Connection, ImportEntry, ApiSettings, ApiProvider, BuildFile, CommandPermission, McpServer, TerminalPermissionEntry } from '../types'
import { defaultProviderManager, type ProviderConfig, type ProviderKind } from '../provider/provider'
import { getUniqueId } from '../utils/uniqueId'

export const PROVIDER_CONFIGS: Record<ApiProvider, { label: string; defaultUrl: string; defaultModel: string }> = {
  llama: { label: 'llama.cpp', defaultUrl: 'http://localhost:8080/', defaultModel: 'deepseek' },
  ollama: { label: 'Ollama', defaultUrl: 'http://127.0.0.1:11434', defaultModel: 'llama3.2' },
  gemini: { label: 'Gemini', defaultUrl: '', defaultModel: 'gemini-2.0-flash-exp' },
  openai: { label: 'OpenAI', defaultUrl: '', defaultModel: 'gpt-4o-mini' },
  openrouter: { label: 'OpenRouter', defaultUrl: '', defaultModel: 'deepseek/deepseek-chat' },
}

const STORAGE_KEY = 'build-agent-settings'

const defaultApiSettings: ApiSettings = {
  provider: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  apiKeys: {},
  baseUrls: {},
  connected: false,
  recentProjects: [],
  disableReasoning: false,
  thinkingEffort: 'default',
  gameSystemPrompt: '',
  favoriteModels: [],
}

function loadSettings(): ApiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return { ...defaultApiSettings, ...JSON.parse(raw) }
  } catch {}
  return defaultApiSettings
}

function saveSettings(settings: ApiSettings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)) } catch {}
}

const initialBuildData = (id: number): BuildData => ({
  id,
  name: `Build ${id}`,
  projectFiles: [],
  timeline: [],
  isRunning: false,
  editingPaths: [],
  workDir: null,
})

interface AppState {
  builds: Record<number, BuildData>
  activeBuild: number | null
  canvasElements: CanvasElement[]
  selectedElements: string[]
  connections: Connection[]
  apiSettings: ApiSettings
  imports: ImportEntry[]
  splitViewEnabled: boolean
  splitPaneBuildIds: number[]
  terminalPermissions: TerminalPermissionEntry[]
  userPrompts: string[]
  mcpServers: McpServer[]
  systemPrompt: string

  addBuildFile: (buildId: number, file: { path: string; content?: string; contentLoaded?: boolean }) => void
  syncBuildFileListing: (buildId: number, paths: string[]) => void
  updateBuildFile: (buildId: number, path: string, content: string) => void
  removeBuildFile: (buildId: number, path: string) => void
  loadBuildFileContent: (buildId: number, path: string) => Promise<string>
  setBuildIsRunning: (buildId: number, isRunning: boolean) => void
  setBuildEditingPaths: (buildId: number, paths: string[]) => void
  setBuildWorkDir: (buildId: number, dir: string | null) => void
  setSplitViewEnabled: (enabled: boolean) => void
  setSplitPaneBuildIds: (ids: number[]) => void
  addBuild: (buildId: number) => void
  setActiveBuild: (buildId: number | null) => void
  addCanvasElement: (element: CanvasElement) => void
  updateCanvasElement: (id: string, updates: Partial<CanvasElement>) => void
  removeCanvasElement: (id: string) => void
  selectElements: (ids: string[]) => void
  addConnection: (connection: Connection) => void
  removeConnection: (id: string) => void
  addBuildTimelineItem: (buildId: number, item: BuildTimelineItem) => void
  updateBuildTimelineItem: (buildId: number, itemId: string, updates: Partial<BuildTimelineItem>) => void
  removeBuildTimelineItem: (buildId: number, itemId: string) => void
  clearBuildTimeline: (buildId: number) => void
  saveImport: (entry: ImportEntry) => void
  updateApiSettings: (settings: Partial<ApiSettings>) => void
  setApiProvider: (provider: ApiProvider) => void
  setApiBaseUrl: (url: string) => void
  setApiModel: (model: string) => void
  setApiKey: (key: string) => void
  setApiConnected: (connected: boolean) => void
  setApiDisableReasoning: (disabled: boolean) => void
  setFavoriteModels: (models: string[]) => void
  setAvailableModels: (models: string[]) => void
  setTerminalPermissions: (perms: TerminalPermissionEntry[]) => void
  setUserPrompts: (prompts: string[]) => void
  addUserPrompt: (prompt: string) => void
  removeUserPrompt: (index: number) => void
  addMcpServer: (server: McpServer) => void
  removeMcpServer: (index: number) => void
  setSystemPrompt: (prompt: string) => void
}

// localStorage in Electron persists to disk natively — fast sync access
const persistStorage = {
  getItem: (name: string): string | null => {
    try { return localStorage.getItem(name) } catch { return null }
  },
  setItem: (name: string, value: string): void => {
    try { localStorage.setItem(name, value) } catch {}
  },
  removeItem: (name: string): void => {
    try { localStorage.removeItem(name) } catch {}
  },
}

// Global abort controllers keyed by buildId — not reactive, shared across remounts
export const buildAbortControllers = new Map<number, AbortController>()

// Debounced auto-save of ALL build data to localStorage
let saveTimer: any = null
function scheduleBuildSave(builds: Record<number, BuildData>) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      const slimBuilds: Record<number, any> = {}
      for (const [id, b] of Object.entries(builds)) {
        slimBuilds[Number(id)] = {
          id: b.id,
          name: b.name,
          timeline: b.timeline.map(t => ({
            id: t.id, type: t.type,
            content: t.content?.length > 5000 ? t.content.slice(0, 5000) + '... [truncated]' : t.content,
            title: t.title, path: t.path, toolName: t.toolName, status: t.status,
            tokenCount: t.tokenCount,
            previewContent: t.previewContent?.length > 2000 ? t.previewContent.slice(0, 2000) + '...' : t.previewContent,
            error: t.error, diffPreview: t.diffPreview, timestamp: t.timestamp,
          })),
          projectFiles: b.projectFiles.map(f => ({ path: f.path })),
          workDir: b.workDir,
        }
      }
      localStorage.setItem('build-agent-conv-all', JSON.stringify(slimBuilds))
      // Keep legacy save for build 0 for backward compat
      const b0 = builds[0]
      if (b0) {
        const slim = slimBuilds[0]
        localStorage.setItem('build-agent-conv', JSON.stringify(slim))
      }
    } catch {}
  }, 2000)
}

export function loadSavedConversation(buildId: number): Partial<BuildData> | null {
  try {
    const raw = localStorage.getItem('build-agent-conv')
    if (!raw) return null
    const data = JSON.parse(raw)
    return data.id === buildId ? data : null
  } catch { return null }
}

export function loadAllSavedConversations(): Record<number, Partial<BuildData>> | null {
  try {
    const raw = localStorage.getItem('build-agent-conv-all')
    if (!raw) return null
    return JSON.parse(raw)
  } catch { return null }
}

export const useAppStore = create<AppState>()(persist(
  (set, get) => ({
  builds: { 0: initialBuildData(0) },
  activeBuild: 0,
  canvasElements: [],
  selectedElements: [],
  connections: [],
  apiSettings: loadSettings(),
  imports: [],
  splitViewEnabled: false,
  splitPaneBuildIds: [0],
  terminalPermissions: [],
  userPrompts: [],
  mcpServers: [],
  systemPrompt: '',

  addBuildFile: (buildId, file) => set(state => {
    const build = state.builds[buildId]
    if (!build || build.projectFiles.find(f => f.path === file.path)) return state
    return {
      builds: {
        ...state.builds,
        [buildId]: {
          ...build,
          projectFiles: [...build.projectFiles, { id: crypto.randomUUID?.() || String(Date.now()), ...file, content: file.content || '', contentLoaded: !!file.content }]
        }
      }
    }
  }),

  syncBuildFileListing: (buildId, paths) => set(state => {
    const build = state.builds[buildId]
    if (!build) return state
    const existing = new Set(build.projectFiles.map(f => f.path))
    const newFiles: BuildFile[] = []
    for (const p of paths) {
      if (!existing.has(p)) {
        newFiles.push({ id: crypto.randomUUID?.() || String(Date.now()), path: p, content: '', contentLoaded: false })
      }
    }
    if (newFiles.length === 0) return state
    return {
      builds: {
        ...state.builds,
        [buildId]: { ...build, projectFiles: [...build.projectFiles, ...newFiles] }
      }
    }
  }),

  updateBuildFile: (buildId, path, content) => set(state => {
    const build = state.builds[buildId]
    if (!build) return state
    const MAX_FILE_SIZE = 50000
    const truncated = content.length > MAX_FILE_SIZE ? content.slice(0, MAX_FILE_SIZE) + '\n// ... truncated' : content
    return {
      builds: {
        ...state.builds,
        [buildId]: {
          ...build,
          projectFiles: build.projectFiles.map(f => f.path === path ? { ...f, content: truncated, contentLoaded: true } : f)
        }
      }
    }
  }),

  removeBuildFile: (buildId, path) => set(state => {
    const build = state.builds[buildId]
    if (!build) return state
    return {
      builds: {
        ...state.builds,
        [buildId]: {
          ...build,
          projectFiles: build.projectFiles.filter(f => f.path !== path)
        }
      }
    }
  }),

  loadBuildFileContent: async (buildId, path) => {
    const state = get()
    const build = state.builds[buildId]
    if (!build) return ''
    const file = build.projectFiles.find(f => f.path === path)
    if (!file) return ''
    if (file.contentLoaded && file.content) return file.content
    // Load from disk lazily
    if (window.electronAPI?.readFile && build.workDir) {
      try {
        const fullPath = build.workDir.replace(/\\/g, '/') + '/' + path
        const content = await window.electronAPI.readFile(fullPath)
        const MAX_FILE_SIZE = 50000
        const truncated = content.length > MAX_FILE_SIZE ? content.slice(0, MAX_FILE_SIZE) + '\n// ... truncated' : content
        // Update store with loaded content
        set(s => ({
          builds: {
            ...s.builds,
            [buildId]: {
              ...s.builds[buildId],
              projectFiles: s.builds[buildId].projectFiles.map(f =>
                f.path === path ? { ...f, content: truncated, contentLoaded: true } : f
              )
            }
          }
        }))
        return truncated
      } catch { return '' }
    }
    return file.content || ''
  },

  setBuildIsRunning: (buildId, isRunning) => set(state => {
    const build = state.builds[buildId]
    if (!build) return state
    return { builds: { ...state.builds, [buildId]: { ...build, isRunning } } }
  }),

  setBuildEditingPaths: (buildId, paths) => set(state => {
    const build = state.builds[buildId]
    if (!build) return state
    return { builds: { ...state.builds, [buildId]: { ...build, editingPaths: paths } } }
  }),

  addCanvasElement: (element) => set(state => ({
    canvasElements: [...state.canvasElements, element]
  })),

  updateCanvasElement: (id, updates) => set(state => ({
    canvasElements: state.canvasElements.map(e => e.id === id ? { ...e, ...updates } : e)
  })),

  removeCanvasElement: (id) => set(state => ({
    canvasElements: state.canvasElements.filter(e => e.id !== id)
  })),

  addConnection: (connection) => set(state => ({
    connections: [...state.connections, connection]
  })),

  removeConnection: (id) => set(state => ({
    connections: state.connections.filter(c => c.id !== id)
  })),

  addBuildTimelineItem: (buildId, item) => set(state => {
    const build = state.builds[buildId]
    if (!build) return state
    // Guard against duplicate IDs
    if (build.timeline.some(t => t.id === item.id)) return state
    const MAX_TIMELINE = 500
    const timeline = build.timeline.length >= MAX_TIMELINE
      ? [...build.timeline.slice(build.timeline.length - MAX_TIMELINE + 1), item]
      : [...build.timeline, item]
    scheduleBuildSave({ ...state.builds, [buildId]: { ...build, timeline } })
    return {
      builds: {
        ...state.builds,
        [buildId]: { ...build, timeline }
      }
    }
  }),

  updateBuildTimelineItem: (buildId, itemId, updates) => set(state => {
    const build = state.builds[buildId]
    if (!build) return state
    scheduleBuildSave(get().builds)
    return {
      builds: {
        ...state.builds,
        [buildId]: {
          ...build,
          timeline: build.timeline.map(t => t.id === itemId ? { ...t, ...updates } : t)
        }
      }
    }
  }),

  removeBuildTimelineItem: (buildId, itemId) => set(state => {
    const build = state.builds[buildId]
    if (!build) return state
    scheduleBuildSave(get().builds)
    return {
      builds: {
        ...state.builds,
        [buildId]: {
          ...build,
          timeline: build.timeline.filter(t => t.id !== itemId)
        }
      }
    }
  }),

  clearBuildTimeline: (buildId) => set(state => {
    const build = state.builds[buildId]
    if (!build) return state
    scheduleBuildSave(get().builds)
    return { builds: { ...state.builds, [buildId]: { ...build, timeline: [] } } }
  }),

  saveImport: (entry) => set(state => ({
    imports: [...state.imports, entry]
  })),
  updateApiSettings: (settings) => set(state => {
    const updated = { ...state.apiSettings, ...settings }
    saveSettings(updated)
    return { apiSettings: updated }
  }),
  setApiProvider: (provider) => set(state => {
    const updated = { ...state.apiSettings, provider: provider as ApiProvider }
    saveSettings(updated)
    defaultProviderManager.add({
      kind: provider as ProviderKind,
      label: provider,
      apiKey: updated.apiKeys?.[provider] || '',
      baseUrl: PROVIDER_CONFIGS[provider as ApiProvider]?.defaultUrl,
      models: [],
      defaultModel: PROVIDER_CONFIGS[provider as ApiProvider]?.defaultModel || '',
    })
    return { apiSettings: updated }
  }),
  setApiBaseUrl: (baseUrl) => set(state => {
    const updated = { ...state.apiSettings, baseUrl }
    saveSettings(updated)
    return { apiSettings: updated }
  }),
  setApiModel: (model) => set(state => {
    const updated = { ...state.apiSettings, model }
    saveSettings(updated)
    return { apiSettings: updated }
  }),
  setApiKey: (apiKey) => set(state => {
    const updated = { ...state.apiSettings, apiKey, apiKeys: { ...state.apiSettings.apiKeys, [state.apiSettings.provider]: apiKey } }
    saveSettings(updated)
    return { apiSettings: updated }
  }),
  setApiConnected: (connected) => set(state => {
    const updated = { ...state.apiSettings, connected }
    saveSettings(updated)
    return { apiSettings: updated }
  }),
  setApiDisableReasoning: (disableReasoning) => set(state => {
    const updated = { ...state.apiSettings, disableReasoning }
    saveSettings(updated)
    return { apiSettings: updated }
  }),
  setApiGamePrompt: (gameSystemPrompt) => set(state => {
    const updated = { ...state.apiSettings, gameSystemPrompt }
    saveSettings(updated)
    return { apiSettings: updated }
  }),
  setFavoriteModels: (favoriteModels) => set(state => {
    const updated = { ...state.apiSettings, favoriteModels }
    saveSettings(updated)
    return { apiSettings: updated }
  }),
  setAvailableModels: (availableModels) => set(state => {
    const updated = { ...state.apiSettings, availableModels }
    saveSettings(updated)
    return { apiSettings: updated }
  }),
  setBuildWorkDir: (buildId, dir) => set(state => {
    const build = state.builds[buildId]
    if (!build) return state
    return { builds: { ...state.builds, [buildId]: { ...build, workDir: dir } } }
  }),
  setSplitViewEnabled: (splitViewEnabled) => set({ splitViewEnabled }),
  setSplitPaneBuildIds: (splitPaneBuildIds) => set({ splitPaneBuildIds }),
  addBuild: (buildId) => set(state => ({
    builds: { ...state.builds, [buildId]: initialBuildData(buildId) }
  })),
  setActiveBuild: (activeBuild) => set({ activeBuild }),
  selectElements: (ids) => set({ selectedElements: ids }),
  setTerminalPermissions: (terminalPermissions) => set({ terminalPermissions }),
  setUserPrompts: (userPrompts) => set({ userPrompts }),
  addUserPrompt: (prompt) => set(state => ({ userPrompts: [...state.userPrompts, prompt] })),
  removeUserPrompt: (index) => set(state => ({ userPrompts: state.userPrompts.filter((_, i) => i !== index) })),
  addMcpServer: (server) => set(state => ({ mcpServers: [...state.mcpServers, server] })),
  removeMcpServer: (index) => set(state => ({ mcpServers: state.mcpServers.filter((_, i) => i !== index) })),
  setSystemPrompt: (systemPrompt) => set({ systemPrompt }),
}),
{
  name: 'build-agent-store',
  storage: persistStorage,
  partialize: (state) => ({
    apiSettings: state.apiSettings,
    terminalPermissions: state.terminalPermissions,
    userPrompts: state.userPrompts,
    mcpServers: state.mcpServers,
    systemPrompt: state.systemPrompt,
  }),
}))
