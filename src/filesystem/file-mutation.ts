/** FileMutation service adapted from opencode's FileMutation.
 *  Provides write-if-unchanged semantics, BOM preservation, and stale content detection.
 */

interface Target {
  canonical: string
  resource: string
}

interface WriteResult {
  operation: 'write' | 'create' | 'remove'
  target: string
  resource: string
  existed: boolean
}

export class StaleContentError extends Error {
  constructor(path: string) {
    super(`File changed after permission approval: ${path}`)
  }
}

export class FileMutation {
  private static locks = new Map<string, Promise<any>>()

  /** Write content to a file, ensuring parent directories exist. */
  static async write(target: Target, content: string): Promise<WriteResult> {
    return FileMutation.withLock(target.canonical, async () => {
      if (!window.electronAPI?.writeBuildFile) throw new Error('File write not available')
      const existed = await FileMutation.exists(target.canonical)
      await window.electronAPI.writeBuildFile({ filePath: target.canonical, content })
      return { operation: 'write', target: target.canonical, resource: target.resource, existed }
    })
  }

  /** Write text content while preserving an existing UTF-8 BOM. */
  static async writeTextPreservingBom(target: Target, content: string): Promise<WriteResult> {
    return FileMutation.withLock(target.canonical, async () => {
      if (!window.electronAPI?.writeBuildFile && !window.electronAPI?.readFile) {
        throw new Error('File operations not available')
      }
      const { bom, text } = FileMutation.splitBom(content)
      let currentHasBom = false
      try {
        if (window.electronAPI?.readFile) {
          const current = await window.electronAPI.readFile(target.canonical)
          currentHasBom = FileMutation.hasUtf8BomStr(current)
        }
      } catch {}
      const finalContent = FileMutation.joinBom(text, currentHasBom || bom)
      const existed = await FileMutation.exists(target.canonical)
      await window.electronAPI.writeBuildFile({ filePath: target.canonical, content: finalContent })
      return { operation: 'write', target: target.canonical, resource: target.resource, existed }
    })
  }

  /** Write only if file still has the expected content (stale detection). */
  static async writeIfUnchanged(target: Target, content: string, expected: string): Promise<WriteResult> {
    return FileMutation.withLock(target.canonical, async () => {
      if (!window.electronAPI?.readFile || !window.electronAPI?.writeBuildFile) {
        throw new Error('File operations not available')
      }
      const current = await window.electronAPI.readFile(target.canonical)
      if (current !== expected) throw new StaleContentError(target.canonical)
      await window.electronAPI.writeBuildFile({ filePath: target.canonical, content })
      return { operation: 'write', target: target.canonical, resource: target.resource, existed: true }
    })
  }

  /** Create file, failing if it already exists. */
  static async create(target: Target, content: string): Promise<WriteResult> {
    return FileMutation.withLock(target.canonical, async () => {
      const existed = await FileMutation.exists(target.canonical)
      if (existed) throw new Error(`File already exists: ${target.canonical}`)
      if (!window.electronAPI?.writeBuildFile) throw new Error('File write not available')
      await window.electronAPI.writeBuildFile({ filePath: target.canonical, content })
      return { operation: 'create', target: target.canonical, resource: target.resource, existed: false }
    })
  }

  /** Remove a file. */
  static async remove(target: Target): Promise<WriteResult> {
    // No direct remove in current Electron API
    const existed = await FileMutation.exists(target.canonical)
    return { operation: 'remove', target: target.canonical, resource: target.resource, existed }
  }

  private static async exists(filepath: string): Promise<boolean> {
    if (!window.electronAPI?.readFile) return false
    try {
      await window.electronAPI.readFile(filepath)
      return true
    } catch {
      return false
    }
  }

  private static async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while (FileMutation.locks.has(key)) {
      await FileMutation.locks.get(key)
    }
    const promise = fn().finally(() => FileMutation.locks.delete(key))
    FileMutation.locks.set(key, promise)
    return promise
  }

  static splitBom(text: string): { bom: boolean; text: string } {
    const stripped = text.replace(/^\uFEFF+/, '')
    return { bom: stripped.length !== text.length, text: stripped }
  }

  static joinBom(text: string, bom: boolean): string {
    const stripped = FileMutation.splitBom(text).text
    return bom ? `\uFEFF${stripped}` : stripped
  }

  static hasUtf8BomStr(content: string): boolean {
    return content.length > 0 && content.charCodeAt(0) === 0xFEFF
  }
}
