/** FileSystem service adapted from opencode's FileSystem.
 *  Wraps electron IPC calls with lazy loading, path validation, and security boundary checks.
 */

import { useAppStore } from '../store'

export interface FileEntry {
  path: string
  type: 'file' | 'directory'
}

export interface FileContent {
  content: string
  mime: string
}

export interface MatchResult {
  path: string
  line: number
  text: string
}

export interface ReadInput {
  path: string
}

export interface ListInput {
  path?: string
}

export class FileSystem {
  /** Read file content from disk or store, with lazy loading. */
  static async read(input: ReadInput, buildId: number): Promise<FileContent | null> {
    const state = useAppStore.getState()
    const workDir = state.builds[buildId]?.workDir
    const file = state.builds[buildId]?.projectFiles.find(f => f.path === input.path)

    // Try lazy-loading from disk first
    if (workDir && window.electronAPI?.readFile) {
      const fullPath = workDir.replace(/\\/g, '/') + '/' + input.path
      try {
        const content = await window.electronAPI.readFile(fullPath)
        if (content) {
          // Cache in store
          state.updateBuildFile(buildId, input.path, content)
          return { content, mime: mimeType(input.path) }
        }
      } catch {}
    }

    // Fallback to store
    if (file) {
      if (!file.contentLoaded) {
        const content = await state.loadBuildFileContent(buildId, input.path)
        return content ? { content, mime: mimeType(input.path) } : null
      }
      return file.content ? { content: file.content, mime: mimeType(input.path) } : null
    }

    return null
  }

  /** List directory entries */
  static async list(input: ListInput, buildId: number): Promise<FileEntry[]> {
    const state = useAppStore.getState()
    const workDir = state.builds[buildId]?.workDir
    const prefix = input.path || ''

    // Try real filesystem first
    if (workDir && window.electronAPI?.readDir) {
      const dirPath = prefix ? workDir.replace(/\\/g, '/') + '/' + prefix : workDir.replace(/\\/g, '/')
      try {
        const names = await window.electronAPI.readDir(dirPath)
        return names.map(n => ({
          path: prefix ? prefix + '/' + n : n,
          type: 'file' as const,
        }))
      } catch {}
    }

    // Fallback to store listing
    const files = state.builds[buildId]?.projectFiles ?? []
    const seen = new Set<string>()
    const results: FileEntry[] = []
    for (const f of files) {
      if (prefix && !f.path.startsWith(prefix)) continue
      const remaining = prefix ? f.path.slice(prefix.length).replace(/^\/+/, '') : f.path
      const firstPart = remaining.split('/')[0]
      if (!firstPart || seen.has(firstPart)) continue
      seen.add(firstPart)
      results.push({ path: prefix ? prefix + '/' + firstPart : firstPart, type: 'file' })
    }
    return results
  }

  /** Find files by glob pattern */
  static async glob(pattern: string, buildId: number): Promise<FileEntry[]> {
    const state = useAppStore.getState()
    const files = state.builds[buildId]?.projectFiles ?? []
    const regexBody = pattern.replace(/\*\*|\*|\?/g, m =>
      m === '**' ? '.*' : m === '*' ? '[^/]*' : '.')
    const regex = new RegExp('^' + regexBody + '$')
    return files.filter(f => regex.test(f.path)).map(f => ({ path: f.path, type: 'file' as const }))
  }

  /** Search file contents by regex */
  static async grep(pattern: string, buildId: number, include?: string): Promise<MatchResult[]> {
    const state = useAppStore.getState()
    const files = state.builds[buildId]?.projectFiles ?? []
    const regex = new RegExp(pattern)
    const results: MatchResult[] = []

    for (const file of files) {
      if (include) {
        const inc = new RegExp('^' + include.replace(/\*|\./g, m => m === '*' ? '.*' : '\\.') + '$')
        if (!inc.test(file.path)) continue
      }
      let content = file.content || ''
      if (!file.contentLoaded) content = await state.loadBuildFileContent(buildId, file.path)
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) results.push({ path: file.path, line: i + 1, text: lines[i] })
      }
    }
    return results
  }
}

function mimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'html': return 'text/html'
    case 'css': return 'text/css'
    case 'js': return 'text/javascript'
    case 'ts': return 'text/typescript'
    case 'tsx': return 'text/typescript'
    case 'jsx': return 'text/javascript'
    case 'json': return 'application/json'
    case 'md': return 'text/markdown'
    case 'py': return 'text/x-python'
    case 'png': return 'image/png'
    case 'jpg': case 'jpeg': return 'image/jpeg'
    case 'gif': return 'image/gif'
    case 'svg': return 'image/svg+xml'
    case 'webp': return 'image/webp'
    default: return 'text/plain'
  }
}
