const isElectron = typeof process !== 'undefined' && process.versions?.electron

export interface Entry { path: string; type: 'file' | 'dir' }
export interface Submatch { text: string; start: number; end: number }
export interface Match { path: string; line: number; offset: number; text: string; submatches: Submatch[] }
export interface FindInput { cwd: string; pattern: string; limit: number; hidden?: boolean; follow?: boolean; signal?: AbortSignal }
export interface GrepInput { cwd: string; pattern: string; file?: string; include?: string; limit: number; signal?: AbortSignal }

let rgPath: string | null = null

const resolveRg = (): string | null => {
  if (!isElectron) return null
  if (rgPath !== null) return rgPath
  try {
    const { execSync } = require('child_process')
    for (const c of ['rg', 'ripgrep']) {
      try { execSync(`${c} --version`, { stdio: 'pipe' }); rgPath = c; return c } catch {}
    }
  } catch {}
  rgPath = ''
  return null
}

const run = (args: string[], opts: { cwd: string; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; code: number }> => {
  const rp = resolveRg()
  if (!rp) return Promise.resolve({ stdout: '', stderr: 'ripgrep not found', code: -1 })
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process')
    const cp = spawn(rp, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], signal: opts.signal })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    cp.stdout.on('data', (d: Buffer) => stdout.push(d))
    cp.stderr.on('data', (d: Buffer) => stderr.push(d))
    cp.on('error', reject)
    cp.on('close', (code: number) => resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), code }))
  })
}

export const find = async (input: FindInput): Promise<Entry[]> => {
  if (!isElectron) return []
  const { stdout, stderr, code } = await run([
    '--no-config', '--files',
    ...(input.hidden ? ['--hidden'] : []),
    ...(input.follow ? ['--follow'] : []),
    ...(input.pattern === '*' ? [] : [`--glob=${input.pattern}`]),
    '--glob=!**/.git/**', '.',
  ], { cwd: input.cwd, signal: input.signal })
  if (code !== 0 && code !== 1) { console.warn('ripgrep find error:', stderr); return [] }
  return stdout.split('\n').filter(Boolean).slice(0, input.limit).map(line => ({ path: line.replace(/\\/g, '/'), type: 'file' as const }))
}

export const glob = async (input: FindInput): Promise<Entry[]> => {
  if (!isElectron) return []
  const { stdout, stderr, code } = await run([
    '--no-config', '--files',
    ...(input.hidden ? ['--hidden'] : []),
    ...(input.follow ? ['--follow'] : []),
    `--glob=${input.pattern}`, '--glob=!**/.git/**', '.',
  ], { cwd: input.cwd, signal: input.signal })
  if (code !== 0 && code !== 1) { console.warn('ripgrep glob error:', stderr); return [] }
  return stdout.split('\n').filter(Boolean).slice(0, input.limit).map(line => ({ path: line.replace(/\\/g, '/'), type: 'file' as const }))
}

export const grep = async (input: GrepInput): Promise<Match[]> => {
  if (!isElectron) return []
  const { stdout, stderr, code } = await run([
    '--no-config', '--json', '--hidden', '--no-messages',
    ...(input.include ? [`--glob=${input.include}`] : []),
    '--glob=!**/.git/**', '--', input.pattern, input.file ?? '.',
  ], { cwd: input.cwd, signal: input.signal })
  if (code !== 0 && code !== 1) { console.warn('ripgrep grep error:', stderr); return [] }
  const results: Match[] = []
  for (const line of stdout.split('\n').filter(Boolean)) {
    try {
      const parsed = JSON.parse(line)
      if (parsed.type !== 'match') continue
      const d = parsed.data
      results.push({
        path: d.path.text.replace(/^\.\//, '').replace(/\\/g, '/'),
        line: d.line_number, offset: d.absolute_offset,
        text: d.lines.text,
        submatches: (d.submatches || []).slice(0, 100).map((s: any) => ({ text: s.match.text, start: s.start, end: s.end })),
      })
      if (results.length >= input.limit) break
    } catch {}
  }
  return results
}
