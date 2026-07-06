import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { BuildData, BuildTimelineItem, CanvasElement, Connection, ImportEntry, ApiSettings, ApiProvider, BuildFile } from '../types'
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
  connections: Connection[]
  apiSettings: ApiSettings
  imports: ImportEntry[]
  splitViewEnabled: boolean
  splitPaneBuildIds: number[]

  addBuildFile: (buildId: number, file: { path: string; content: string }) => void
  updateBuildFile: (buildId: number, path: string, content: string) => void
  removeBuildFile: (buildId: number, path: string) => void
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
}

// Custom storage: uses Electron IPC file if available, falls back to localStorage
const persistStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (window.electronAPI?.loadStoreData) {
      return await window.electronAPI.loadStoreData()
    }
    try { return localStorage.getItem(name) } catch { return null }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    const payload = typeof value === 'string' ? value : JSON.stringify(value)
    if (window.electronAPI?.saveStoreData) {
      await window.electronAPI.saveStoreData(payload)
    }
    try { localStorage.setItem(name, payload) } catch {}
  },
  removeItem: async (name: string): Promise<void> => {
    if (window.electronAPI?.saveStoreData) {
      await window.electronAPI.saveStoreData('')
    }
    try { localStorage.removeItem(name) } catch {}
  },
}

// Global abort controllers keyed by buildId — not reactive, shared across remounts
export const buildAbortControllers = new Map<number, AbortController>()

export const useAppStore = create<AppState>()(persist(
  (set) => ({
  builds: { 0: initialBuildData(0) },
  activeBuild: 0,
  canvasElements: [],
  connections: [],
  apiSettings: loadSettings(),
  imports: [],
  splitViewEnabled: false,
  splitPaneBuildIds: [0],

  addBuildFile: (buildId, file) => set(state => {
    const build = state.builds[buildId]
    if (!build || build.projectFiles.find(f => f.path === file.path)) return state
    return {
      builds: {
        ...state.builds,
        [buildId]: {
          ...build,
          projectFiles: [...build.projectFiles, { id: crypto.randomUUID?.() || String(Date.now()), ...file }]
        }
      }
    }
  }),

  updateBuildFile: (buildId, path, content) => set(state => {
    const build = state.builds[buildId]
    if (!build) return state
    return {
      builds: {
        ...state.builds,
        [buildId]: {
          ...build,
          projectFiles: build.projectFiles.map(f => f.path === path ? { ...f, content } : f)
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
    return {
      builds: {
        ...state.builds,
        [buildId]: { ...build, timeline: [...build.timeline, item] }
      }
    }
  }),

  updateBuildTimelineItem: (buildId, itemId, updates) => set(state => {
    const build = state.builds[buildId]
    if (!build) return state
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
  selectElements: () => {},
}),
{
  name: 'build-agent-store',
  storage: persistStorage,
  partialize: (state) => ({
    builds: state.builds,
    activeBuild: state.activeBuild,
    canvasElements: state.canvasElements,
    connections: state.connections,
    apiSettings: state.apiSettings,
    imports: state.imports,
    splitViewEnabled: state.splitViewEnabled,
    splitPaneBuildIds: state.splitPaneBuildIds,
  }),
}))
