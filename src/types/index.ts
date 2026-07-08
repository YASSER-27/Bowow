export interface BuildFile {
  id: string
  path: string
  content: string
  /** Whether this file's content is loaded from disk (false = path-only listing) */
  contentLoaded?: boolean
}

export interface BuildFileEvent {
  action: 'create' | 'edit' | 'read' | 'run'
  path: string
  stats: { added: number; removed: number }
  status: 'success' | 'error'
  content?: string
  error?: string
}

export interface BuildToolCall {
  id?: string
  name: string
  arguments: Record<string, any>
  argumentsStr?: string
}

export interface BuildTimelineItem {
  id: string
  type: 'user' | 'assistant' | 'file' | 'tool' | 'error' | 'system'
  content?: string
  title?: string
  path?: string
  toolName?: string
  toolCalls?: BuildToolCall[]
  status?: 'running' | 'success' | 'error'
  stats?: { added: number; removed: number }
  timestamp: number
  isStreaming?: boolean
  inlineData?: { mimeType: string; data: string }[]
  previewContent?: string
  diffPreview?: string
  tokenCount?: number
  iframeSrcDoc?: string
  action?: string
  error?: string
}

export enum BuildErrorReason {
  VALIDATION = 'validation',
  API = 'api',
  TOOL = 'tool',
  TIMEOUT = 'timeout',
  CONTEXT_LIMIT = 'context_limit',
  UNKNOWN = 'unknown',
}

export class BuildError extends Error {
  reason: BuildErrorReason
  details?: string

  constructor(message: string, reason: BuildErrorReason = BuildErrorReason.UNKNOWN, details?: string) {
    super(message)
    this.name = 'BuildError'
    this.reason = reason
    this.details = details
  }
}

export interface BuildData {
  id: number
  name: string
  projectFiles: BuildFile[]
  timeline: BuildTimelineItem[]
  isRunning: boolean
  editingPaths: string[]
  workDir?: string | null
}

export interface CanvasElement {
  id: string
  componentId: string
  x: number
  y: number
  width: number
  height: number
  name: string
  category: string
  type: string
  html: string
  css: string
  js: string
  iframeSrcDoc?: string
  description: string
  source: string
  mode: string
}

export interface Connection {
  id: string
  fromId: string
  toId: string
}

export type ApiProvider = 'llama' | 'ollama' | 'gemini' | 'openai' | 'openrouter' | 'deepseek' | ''

export interface ApiSettings {
  provider: ApiProvider
  baseUrl: string
  model: string
  apiKey: string
  apiKeys: Record<string, string>
  baseUrls: Record<string, string>
  connected: boolean
  projectDir?: string
  recentProjects: string[]
  disableReasoning?: boolean
  favoriteModels?: string[]
  disableReasoning?: boolean
  thinkingEffort?: 'default' | 'low' | 'high'
  favoriteModels?: string[]
}

export type CommandPermission = 'allow' | 'ask' | 'deny'

export interface TerminalPermissionEntry {
  command: string
  permission: CommandPermission
}

export interface McpServer {
  name: string
  url: string
  tools: string[]
}

export interface ImportEntry {
  name: string
  html: string
  css: string
  js: string
  source: string
}

  declare global {
    interface Window {
      electronAPI?: {
        readFile: (path: string) => Promise<string>
        readDir: (path: string) => Promise<string[]>
        readDirRecursive: (path: string) => Promise<string[]>
        getBuildDirectory: () => Promise<string>
        getNewComponentsPath: () => Promise<string>
        saveDesignerImage: (projectId: string, fileName: string, base64: string) => Promise<string>
        getDesignerProjectPath: (projectId: string) => Promise<string>
        generateImage: (params: { prompt: string; aspectRatio?: string }) => Promise<string>
        editImage: (params: { prompt: string; imageBase64?: string; aspectRatio?: string }) => Promise<string>
        saveImageFile: (base64: string, defaultName: string) => Promise<boolean>
        saveBuildFile: (params: { content: string; defaultName: string }) => Promise<boolean>
        writeBuildFile: (params: { filePath: string; content: string }) => Promise<boolean>
        runCommand: (params: { command: string; cwd?: string }) => Promise<{ stdout: string; stderr: string; exitCode: number; error?: string | null }>
        selectDirectory: () => Promise<string | null>
        saveStoreData: (data: string) => Promise<void>
        loadStoreData: () => Promise<string | null>
        windowMinimize: () => void
        windowMaximize: () => void
        windowClose: () => void
        toggleFullScreen: () => void
        isFullScreen: () => Promise<boolean>
        checkForUpdate: () => Promise<void>
        downloadUpdate: () => Promise<void>
        installUpdate: () => Promise<void>
        onUpdateStatus: (callback: (status: UpdateStatus) => void) => void
      }
    }
  }

  export interface UpdateStatus {
    status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'
    version?: string
    releaseDate?: string
    releaseNotes?: string
    percent?: number
    bytesPerSecond?: number
    message?: string
    downloadUrl?: string
  }
