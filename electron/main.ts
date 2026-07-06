import { app, BrowserWindow, Menu, nativeImage, ipcMain, dialog, shell } from 'electron'
import path from 'node:path'
import { spawn, ChildProcess, exec } from 'node:child_process'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import WebSocket from 'ws'

process.env.DIST = path.join(__dirname, '../dist')
process.env.VITE_PUBLIC = app.isPackaged ? process.env.DIST : path.join(process.env.DIST, '../public')

let mainWindow: BrowserWindow | null = null

const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

const iconPath = path.join(__dirname, '../src/assets/icon.png')
const appIcon = nativeImage.createFromPath(iconPath)

let serverProcess: ChildProcess | null = null
const CPP_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'cpp')
  : path.join(__dirname, '../cpp')

function checkPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.createConnection(port, '127.0.0.1', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
  })
}

ipcMain.handle('start-server', async () => {
  if (serverProcess) return 'already-running'
  const exePath = path.join(CPP_DIR, 'llama-server.exe')
  const modelPath = path.join(CPP_DIR, 'DeepSeek.gguf')
  try {
    serverProcess = spawn(exePath, ['-m', modelPath, '--port', '8080', '-ngl', '999', '-t', '8', '-c', '4096'], {
      cwd: CPP_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    serverProcess.stdout?.on('data', () => {})
    serverProcess.stderr?.on('data', () => {})
    serverProcess.on('exit', () => { serverProcess = null })
    return 'started'
  } catch {
    return 'failed'
  }
})

ipcMain.handle('stop-server', () => {
  if (serverProcess) { serverProcess.kill(); serverProcess = null }
})

ipcMain.handle('is-server-running', async () => {
  return await checkPort(8080)
})

ipcMain.handle('read-file', async (_event, filePath: string) => {
  return await fs.readFile(filePath, 'utf-8')
})

ipcMain.handle('read-dir', async (_event, dirPath: string) => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  return entries.filter(e => e.isFile()).map(e => e.name)
})

ipcMain.handle('read-dir-recursive', async (_event, dirPath: string) => {
  const results: string[] = []
  async function walk(dir: string) {
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile()) {
        results.push(fullPath)
      }
    }
  }
  await walk(dirPath)
  return results
})

ipcMain.handle('save-designer-image', async (_event, projectId: string, fileName: string, base64Data: string) => {
  const fs = await import('node:fs/promises')
  const projectsDir = path.join(app.getPath('userData'), 'designer27-projects', projectId, 'images')
  await fs.mkdir(projectsDir, { recursive: true })
  const buf = Buffer.from(base64Data.replace(/^data:image\/\w+;base64,/, ''), 'base64')
  const filePath = path.join(projectsDir, fileName)
  await fs.writeFile(filePath, buf)
  return `./images/${fileName}`
})

ipcMain.handle('get-designer-project-path', async (_event, projectId: string) => {
  return path.join(app.getPath('userData'), 'designer27-projects', projectId, 'images')
})

// FreeGen Constants
const SIGNER_URL = 'https://prompt-signer.freegen.app'
const GENERATOR_URL = 'https://image-generator.freegen.app'
const WEBSOCKET_URL = 'wss://websocket-bridge.freegen.app/ws'

async function generateFreeGenImage(prompt: string, ratio: string): Promise<string> {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Content-Type': 'application/json',
  }

  // 1. Prompt Signer
  const signerRes = await fetch(SIGNER_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ prompt }),
  })
  if (!signerRes.ok) throw new Error(`FreeGen Signer Error: ${signerRes.statusText}`)
  const { ts, sig } = (await signerRes.json()) as { ts: number; sig: string }

  // 2. Generate Image job
  const genRes = await fetch(GENERATOR_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ prompt, ts, sig, ratio_id: ratio }),
  })
  if (!genRes.ok) throw new Error(`FreeGen Generator Error: ${genRes.statusText}`)
  const genData = (await genRes.json()) as { job_id?: string; image_data_url?: string }
  if (!genData.job_id) {
    if (genData.image_data_url) return genData.image_data_url
    throw new Error('FreeGen did not return a job ID or immediate image')
  }

  // 3. WebSocket bridge for result
  return new Promise((resolve, reject) => {
    const wsTs = Math.floor(Date.now() / 1000)
    const msg = `${genData.job_id}${wsTs}`
    const hash = crypto.createHash('sha256').update(msg).digest('hex')
    const auth = Buffer.from(hash).toString('base64').substring(0, 20) + ':' + wsTs

    const ws = new WebSocket(WEBSOCKET_URL)
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Timeout waiting for FreeGen result')) }, 45000)

    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', job_id: genData.job_id, auth })))
    ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data.toString())
        if (payload.type === 'result') {
          clearTimeout(timeout); ws.close()
          if (payload.image_data) resolve(payload.image_data)
          else reject(new Error('FreeGen result missing image data'))
        }
      } catch (err) { clearTimeout(timeout); ws.close(); reject(err) }
    })
    ws.on('error', (err) => { clearTimeout(timeout); ws.close(); reject(err) })
  })
}

ipcMain.handle('generate-image', async (_event, params: { prompt: string; aspectRatio?: string }) => {
  const ratio = params.aspectRatio?.trim() || '1:1'
  const valid = ['1:1', '4:3', '3:4', '16:9', '9:16']
  const ratioId = valid.includes(ratio) ? ratio : '1:1'
  return await generateFreeGenImage(params.prompt, ratioId)
})

ipcMain.handle('save-image-file', async (_event, base64: string, defaultName: string) => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) throw new Error('No window')
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName || 'image.png',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  })
  if (result.canceled || !result.filePath) return false
  const buf = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
  await fs.writeFile(result.filePath, buf)
  return true
})

ipcMain.handle('open-file', async (_event, filePath: string) => {
  return await shell.openPath(filePath)
})

ipcMain.handle('save-build-file', async (_event, { content, defaultName }) => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) throw new Error('No window')
  const result = await dialog.showSaveDialog(win, {
    defaultPath: defaultName || 'file.txt',
    filters: [{ name: 'All Files', extensions: ['*'] }],
  })
  if (result.canceled || !result.filePath) return false
  await fs.writeFile(result.filePath, content, 'utf-8')
  return true
})

ipcMain.handle('edit-image', async (_event, params: { prompt: string; imageBase64?: string; aspectRatio?: string }) => {
  // Enhance prompt with image context if provided
  const enhancedPrompt = params.imageBase64
    ? `${params.prompt} (based on the provided reference image — apply this modification to the image style/content)`
    : params.prompt
  const ratio = params.aspectRatio?.trim() || '1:1'
  const valid = ['1:1', '4:3', '3:4', '16:9', '9:16']
  return await generateFreeGenImage(enhancedPrompt, valid.includes(ratio) ? ratio : '1:1')
})

ipcMain.handle('get-new-components-path', async () => {
  const dataDir = app.isPackaged
    ? path.join(process.resourcesPath, 'data', 'components', 'New')
    : path.join(__dirname, '..', 'src', 'data', 'components', 'New')
  return dataDir
})

ipcMain.handle('select-project-dir', async () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) throw new Error('No window')
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('select-directory', async () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) throw new Error('No window')
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('save-store-data', async (_event, data: string | Record<string, unknown> | null) => {
  const storePath = path.join(app.getPath('userData'), 'build-agent-store.json')
  await fs.mkdir(path.dirname(storePath), { recursive: true })
  const payload = typeof data === 'string' ? data : JSON.stringify(data ?? {})
  await fs.writeFile(storePath, payload, 'utf-8')
})

ipcMain.handle('load-store-data', async () => {
  const storePath = path.join(app.getPath('userData'), 'build-agent-store.json')
  try {
    return await fs.readFile(storePath, 'utf-8')
  } catch {
    return null
  }
})

ipcMain.handle('get-build-directory', async () => {
  return path.join(app.getPath('userData'), 'build-beta')
})

ipcMain.handle('write-build-file', async (_event, { filePath, content, projectDir }) => {
  const targetDir = projectDir || path.join(app.getPath('userData'), 'build-beta')
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(targetDir, filePath)
  await fs.mkdir(path.dirname(fullPath), { recursive: true })
  await fs.writeFile(fullPath, content, 'utf-8')
  return true
})

ipcMain.handle('run-command', async (_event, { command, cwd }) => {
  const executionCwd = cwd || path.join(app.getPath('userData'), 'build-beta')
  return new Promise((resolve) => {
    exec(command, { cwd: executionCwd }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: error ? error.code || 1 : 0,
        error: error ? error.message : null,
      })
    })
  })
})

ipcMain.handle('scan-model', async (_event, { provider, model, localUrl, localKey }: { provider: string; model: string; localUrl: string; localKey: string }) => {
  const maxRetries = 3
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let t0 = 0
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      let url = ''
      let body: any
      if (provider === 'gemini') {
        const cleanModel = model.replace(/^models\//, '')
        if (!/^(gemini|gemma|learnlm)/i.test(cleanModel)) {
          return { ms: 0, error: 'skipped' }
        }
        url = `https://generativelanguage.googleapis.com/v1beta/models/${cleanModel}:generateContent?key=${localKey}`
        body = { contents: [{ parts: [{ text: 'Hi' }] }], generationConfig: { maxOutputTokens: 1 } }
      } else {
        const baseUrl = provider === 'openai' ? 'https://api.openai.com/v1'
          : provider === 'openrouter' ? 'https://openrouter.ai/api/v1'
          : localUrl.replace(/\/+$/, '')
        if (provider === 'ollama' && !localUrl.includes('/v1')) {
          url = `${localUrl.replace(/\/+$/, '')}/api/chat`
          body = { model, messages: [{ role: 'user', content: 'Hi' }], stream: false, options: { num_predict: 1 } }
        } else {
          url = `${baseUrl}/chat/completions`
          if (localKey) headers['Authorization'] = `Bearer ${localKey}`
          body = { model, messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1 }
        }
      }
      t0 = Date.now()
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
      if (res.status === 429 && attempt < maxRetries - 1) {
        const delay = (attempt + 1) * 2000
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      await res.json()
      return { ms: Date.now() - t0 }
    } catch (err: any) {
      if (attempt < maxRetries - 1 && err.message?.includes('429')) {
        const delay = (attempt + 1) * 2000
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      return { ms: Date.now() - t0, error: err.message || 'Request failed' }
    }
  }
  return { ms: 0, error: 'Max retries exceeded' }
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700,
    height: 530,
    minWidth: 400,
    minHeight: 500,
    frame: false,
    backgroundColor: '#121212',
    icon: appIcon,
    title: 'Bowow Beta',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  ipcMain.on('window-minimize', () => mainWindow?.minimize())
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize()
  })
  ipcMain.on('window-close', () => mainWindow?.close())
  ipcMain.on('toggle-fullscreen', () => {
    if (mainWindow?.isFullScreen()) mainWindow.setFullScreen(false); else mainWindow?.setFullScreen(true)
  })
  ipcMain.handle('is-fullscreen', () => mainWindow?.isFullScreen() || false)

  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(process.env.DIST!, 'index.html'))
  }

  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.key === 'F12') {
      mainWindow?.webContents.toggleDevTools()
    }
  })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createWindow()
})

app.on('before-quit', () => {
  if (serverProcess) { serverProcess.kill(); serverProcess = null }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    mainWindow = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})
