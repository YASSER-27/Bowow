const isElectron = typeof process !== 'undefined' && process.versions?.electron
const SHELL = isElectron
  ? (process.env.COMSPEC || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'))
  : '/bin/sh'

export interface Disp {
  dispose(): void
}

export interface Exit {
  exitCode: number
  signal?: string
}

export interface Proc {
  pid: number
  onData(listener: (data: string) => void): Disp
  onExit(listener: (event: Exit) => void): Disp
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface ProcOpts {
  name: string
  cols?: number
  rows?: number
  cwd?: string
  env?: Record<string, string>
}

export const create = (opts: ProcOpts): Proc => {
  if (!isElectron) {
    // Browser fallback — no real PTY
    const noop = () => {}
    return {
      pid: 0, onData: () => ({ dispose: noop }), onExit: () => ({ dispose: noop }),
      write: noop, resize: noop, kill: noop,
    }
  }
  const { spawn } = require('child_process')
  const cp = spawn(SHELL, [], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true,
  })
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: Exit) => void>()
  cp.stdout?.on('data', (data: Buffer) => { for (const fn of dataListeners) fn(data.toString('utf8')) })
  cp.stderr?.on('data', (data: Buffer) => { for (const fn of dataListeners) fn(data.toString('utf8')) })
  cp.on('exit', (code: number, signal: string) => {
    const event: Exit = { exitCode: code ?? -1, signal: signal?.toString() }
    for (const fn of exitListeners) fn(event)
  })
  cp.on('error', (err: Error) => { for (const fn of exitListeners) fn({ exitCode: -1, signal: err.message }) })
  return {
    pid: cp.pid ?? 0,
    onData(listener) { dataListeners.add(listener); return { dispose() { dataListeners.delete(listener) } } },
    onExit(listener) { exitListeners.add(listener); return { dispose() { exitListeners.delete(listener) } } },
    write(data) { cp.stdin?.write(data) },
    resize(_cols, _rows) {},
    kill(signal) { cp.kill(signal) },
  }
}

export const execCommand = (command: string, opts: { cwd?: string; timeout?: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; code: number }> => {
  if (!isElectron) {
    return Promise.resolve({ stdout: '', stderr: 'PTY not available in browser', code: -1 })
  }
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process')
    const cp = spawn(command, [], {
      cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: true, signal: opts.signal,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    cp.stdout.on('data', (d: Buffer) => stdout.push(d))
    cp.stderr.on('data', (d: Buffer) => stderr.push(d))
    cp.on('error', reject)
    cp.on('close', (code: number) => {
      resolve({ stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), code: code ?? -1 })
    })
  })
}
