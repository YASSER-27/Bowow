const isElectron = typeof process !== 'undefined' && process.versions?.electron

interface FormatterInfo {
  name: string
  extensions: string[]
  command: string[]
  check: () => boolean
}

const FORMATTERS: FormatterInfo[] = [
  { name: 'prettier', extensions: ['.js', '.jsx', '.ts', '.tsx', '.json', '.css', '.html', '.md', '.yaml', '.yml'], command: ['prettier', '--write'], check: () => { try { if (!isElectron) return false; const { execSync } = require('child_process'); execSync('prettier --version', { stdio: 'pipe' }); return true } catch { return false } } },
  { name: 'rustfmt', extensions: ['.rs'], command: ['rustfmt'], check: () => { try { if (!isElectron) return false; const { execSync } = require('child_process'); execSync('rustfmt --version', { stdio: 'pipe' }); return true } catch { return false } } },
  { name: 'black', extensions: ['.py'], command: ['black', '-q'], check: () => { try { if (!isElectron) return false; const { execSync } = require('child_process'); execSync('black --version', { stdio: 'pipe' }); return true } catch { return false } } },
  { name: 'go fmt', extensions: ['.go'], command: ['gofmt', '-w'], check: () => { try { if (!isElectron) return false; const { execSync } = require('child_process'); execSync('gofmt --version', { stdio: 'pipe' }); return true } catch { return false } } },
]

export interface FormatterStatus {
  name: string
  extensions: string[]
  enabled: boolean
}

let initialized = false
let enabledFormatters: FormatterInfo[] = []

const getElectronExecSync = (): ((cmd: string) => string) | null => {
  if (!isElectron) return null
  try { return require('child_process').execSync } catch { return null }
}

export const init = (): void => {
  if (initialized) return
  initialized = true
  if (!isElectron) return
  enabledFormatters = FORMATTERS.filter(f => f.check())
}

export const status = (): FormatterStatus[] =>
  FORMATTERS.map(f => ({
    name: f.name,
    extensions: f.extensions,
    enabled: enabledFormatters.some(e => e.name === f.name),
  }))

export const formatFile = (filepath: string): boolean => {
  init()
  const ext = '.' + filepath.split('.').pop()?.toLowerCase()
  const formatter = enabledFormatters.find(f => f.extensions.includes(ext))
  if (!formatter) return false
  try {
    const execSync = getElectronExecSync()
    if (!execSync) return false
    execSync([...formatter.command, filepath].join(' '))
    return true
  } catch (e) {
    console.warn(`Formatter ${formatter.name} failed:`, e)
    return false
  }
}

export const formatAll = (files: string[]): void => {
  init()
  for (const file of files) formatFile(file)
}
