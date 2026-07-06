export function normalizePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

export function joinPaths(...parts: string[]): string {
  return normalizePath(parts.join('/'))
}

export function dirname(path: string): string {
  const normal = normalizePath(path).replace(/\/$/, '')
  const idx = normal.lastIndexOf('/')
  return idx === -1 ? '.' : normal.slice(0, idx) || '/'
}

export function basename(path: string, ext?: string): string {
  const base = normalizePath(path).split('/').pop() || ''
  if (ext && base.endsWith(ext)) return base.slice(0, -ext.length)
  return base
}

export function extname(path: string): string {
  const base = basename(path)
  const idx = base.lastIndexOf('.')
  return idx === -1 ? '' : base.slice(idx)
}
