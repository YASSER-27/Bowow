const isElectron = typeof process !== 'undefined' && process.versions?.electron

export interface SnapshotPatch {
  hash: string
  files: string[]
}

export interface FileDiff {
  file: string
  additions: number
  deletions: number
  hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; content: string }>
}

const getGit = () => {
  if (!isElectron) return null
  const { execSync } = require('child_process')
  return (...args: string[]) => {
    const result = execSync(`git ${args.join(' ')}`, { encoding: 'utf8', stdio: 'pipe' })
    return result.trim()
  }
}

const getOS = () => {
  if (!isElectron) return null
  return require('os')
}

const getPath = () => {
  if (!isElectron) return null
  return require('path')
}

const getFS = () => {
  if (!isElectron) return null
  return require('fs')
}

const snapshotDir = (worktree: string): string | null => {
  const os = getOS()
  const path = getPath()
  const fs = getFS()
  if (!os || !path || !fs) return null
  const dir = path.join(os.tmpdir(), 'bowow-snapshots', Buffer.from(worktree).toString('base64url'))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export const init = (worktree: string): void => {
  const git = getGit()
  const path = getPath()
  const fs = getFS()
  if (!git || !path || !fs) return
  try { git('status', '--porcelain', '-C', worktree) } catch {
    git('init', '-C', worktree)
  }
  const dir = snapshotDir(worktree)
  if (dir && !fs.existsSync(path.join(dir, 'HEAD'))) {
    git('init', '--bare', dir)
  }
}

export const track = (worktree: string): string | undefined => {
  const git = getGit()
  const path = getPath()
  if (!git || !path) return undefined
  const dir = snapshotDir(worktree)
  if (!dir) return undefined
  git('add', '-A', '-C', worktree)
  const hasChanges = git('status', '--porcelain', '-C', worktree).length > 0
  if (!hasChanges) return undefined
  git(`--git-dir=${dir}`, `--work-tree=${worktree}`, 'add', '-A')
  const hash = git(`--git-dir=${dir}`, `--work-tree=${worktree}`, 'commit', '-m', `snapshot ${Date.now()}`, '--allow-empty')
  return hash
}

export const patch = (worktree: string, hash: string): SnapshotPatch => {
  const git = getGit()
  const path = getPath()
  if (!git || !path) return { hash, files: [] }
  const dir = snapshotDir(worktree)
  if (!dir) return { hash, files: [] }
  const files = git(`--git-dir=${dir}`, 'diff-tree', '--no-commit-id', '-r', '--name-only', '-z', hash)
    .split('\0').filter(Boolean)
  return { hash, files }
}

export const restore = (worktree: string, snapshot: string): void => {
  const git = getGit()
  const path = getPath()
  if (!git || !path) return
  const dir = snapshotDir(worktree)
  if (!dir) return
  git(`--git-dir=${dir}`, `--work-tree=${worktree}`, 'checkout', snapshot, '--', '.')
}

export const revert = (worktree: string, patches: SnapshotPatch[]): void => {
  const git = getGit()
  const { exec } = require('child_process')
  const path = getPath()
  if (!git || !path) return
  const dir = snapshotDir(worktree)
  if (!dir) return
  for (const p of patches) {
    const diff = git(`--git-dir=${dir}`, 'diff', `${p.hash}^..${p.hash}`, '--binary')
    const proc = exec('git apply', { cwd: worktree })
    proc.stdin?.write(diff)
    proc.stdin?.end()
  }
}

export const diff = (worktree: string, hash: string): string => {
  const git = getGit()
  const path = getPath()
  if (!git || !path) return ''
  const dir = snapshotDir(worktree)
  if (!dir) return ''
  return git(`--git-dir=${dir}`, 'diff', `${hash}^..${hash}`)
}

export const diffFull = (worktree: string, from: string, to: string): FileDiff[] => {
  const git = getGit()
  const path = getPath()
  if (!git || !path) return []
  const dir = snapshotDir(worktree)
  if (!dir) return []
  const output = git(`--git-dir=${dir}`, 'diff', '--numstat', from, to)
  const files: FileDiff[] = []
  for (const line of output.split('\n').filter(Boolean)) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    files.push({
      file: parts[2],
      additions: parseInt(parts[0]) || 0,
      deletions: parseInt(parts[1]) || 0,
      hunks: [],
    })
  }
  return files
}
