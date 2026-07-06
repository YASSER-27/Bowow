import type { BuildFileEvent } from '../types'

const DEFAULT_GITIGNORE = `node_modules/
dist/
dist-electron/
build/
release/
.env
.env.local
*.log
.DS_Store
Thumbs.db
*.tmp
.vscode/
.idea/
`

async function ensureGitignore(): Promise<void> {
  if (!window.electronAPI) return
  try {
    const buildDir = (await window.electronAPI.getBuildDirectory()).replace(/\\/g, '/')
    const gitignorePath = buildDir + '/.gitignore'
    await window.electronAPI.readFile(gitignorePath)
  } catch {
    await window.electronAPI.writeBuildFile({ filePath: '.gitignore', content: DEFAULT_GITIGNORE })
  }
}

export async function execGitStatus(): Promise<BuildFileEvent> {
  if (!window.electronAPI) {
    return { action: 'run', path: '.', stats: { added: 0, removed: 0 }, status: 'error', error: 'electronAPI not available' }
  }
  await window.electronAPI.getBuildDirectory()
  const result = await window.electronAPI.runCommand({ command: 'git status', cwd: '' })
  if (result.exitCode !== 0 && result.stderr?.includes('not a git repository')) {
    await window.electronAPI.runCommand({ command: 'git init', cwd: '' })
    await ensureGitignore()
    return { action: 'run', path: '.', stats: { added: 0, removed: 0 }, status: 'success', content: '(initialized new git repository)\n\nNo commits yet. Run git_commit to create the first commit.' }
  }
  return { action: 'run', path: '.', stats: { added: 0, removed: 0 }, status: result.exitCode === 0 ? 'success' : 'error', content: (result.stdout + '\n' + result.stderr).trim(), error: result.error || undefined }
}

export async function execGitDiff(): Promise<BuildFileEvent> {
  if (!window.electronAPI) {
    return { action: 'run', path: '.', stats: { added: 0, removed: 0 }, status: 'error', error: 'electronAPI not available' }
  }
  const result = await window.electronAPI.runCommand({ command: 'git diff', cwd: '' })
  const staged = await window.electronAPI.runCommand({ command: 'git diff --cached', cwd: '' })
  const content = [result.stdout?.trim() ? `Unstaged changes:\n${result.stdout.trim()}` : '', staged.stdout?.trim() ? `Staged changes:\n${staged.stdout.trim()}` : ''].filter(Boolean).join('\n\n') || '(no changes)'
  return { action: 'run', path: '.', stats: { added: 0, removed: 0 }, status: 'success', content }
}

export async function execGitLog(): Promise<BuildFileEvent> {
  if (!window.electronAPI) {
    return { action: 'run', path: '.', stats: { added: 0, removed: 0 }, status: 'error', error: 'electronAPI not available' }
  }
  const result = await window.electronAPI.runCommand({ command: 'git log --oneline -10', cwd: '' })
  return { action: 'run', path: '.', stats: { added: 0, removed: 0 }, status: result.exitCode === 0 ? 'success' : 'error', content: (result.stdout + '\n' + result.stderr).trim(), error: result.error || undefined }
}

export async function execGitCommit(message: string): Promise<BuildFileEvent> {
  if (!window.electronAPI) {
    return { action: 'run', path: '.', stats: { added: 0, removed: 0 }, status: 'error', error: 'electronAPI not available' }
  }
  const msg = message || 'Update'
  const addResult = await window.electronAPI.runCommand({ command: 'git add -A', cwd: '' })
  if (addResult.exitCode !== 0) {
    return { action: 'run', path: '.', stats: { added: 0, removed: 0 }, status: 'error', content: addResult.stderr, error: addResult.error || undefined }
  }
  const commitResult = await window.electronAPI.runCommand({ command: `git commit -m "${msg.replace(/"/g, '\\"')}"`, cwd: '' })
  return { action: 'run', path: '.', stats: { added: 0, removed: 0 }, status: commitResult.exitCode === 0 ? 'success' : 'error', content: (commitResult.stdout + '\n' + commitResult.stderr).trim(), error: commitResult.error || undefined }
}
