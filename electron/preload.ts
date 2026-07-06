import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  readFile: (path: string) => ipcRenderer.invoke('read-file', path),
  readDir: (path: string) => ipcRenderer.invoke('read-dir', path),
  readDirRecursive: (path: string) => ipcRenderer.invoke('read-dir-recursive', path),
  getBuildDirectory: () => ipcRenderer.invoke('get-build-directory'),
  selectProjectDir: () => ipcRenderer.invoke('select-project-dir'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  openFile: (path: string) => ipcRenderer.invoke('open-file', path),

  getNewComponentsPath: () => ipcRenderer.invoke('get-new-components-path'),
  saveDesignerImage: (projectId: string, fileName: string, base64: string) => ipcRenderer.invoke('save-designer-image', projectId, fileName, base64),
  getDesignerProjectPath: (projectId: string) => ipcRenderer.invoke('get-designer-project-path', projectId),
  generateImage: (params: { prompt: string; aspectRatio?: string }) => ipcRenderer.invoke('generate-image', params),
  editImage: (params: { prompt: string; imageBase64?: string; aspectRatio?: string }) => ipcRenderer.invoke('edit-image', params),
  saveImageFile: (base64: string, defaultName: string) => ipcRenderer.invoke('save-image-file', base64, defaultName),
  saveBuildFile: ({ content, defaultName }: { content: string; defaultName: string }) => ipcRenderer.invoke('save-build-file', { content, defaultName }),
  writeBuildFile: ({ filePath: path, content, projectDir }: { filePath: string; content: string; projectDir?: string }) => ipcRenderer.invoke('write-build-file', { filePath: path, content, projectDir }),
  runCommand: ({ command, cwd }: { command: string; cwd?: string }) => ipcRenderer.invoke('run-command', { command, cwd }),
  scanModel: (params: { provider: string; model: string; localUrl: string; localKey: string }) => ipcRenderer.invoke('scan-model', params),
  saveStoreData: (data: string) => ipcRenderer.invoke('save-store-data', data),
  loadStoreData: () => ipcRenderer.invoke('load-store-data'),
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  toggleFullScreen: () => ipcRenderer.send('toggle-fullscreen'),
  isFullScreen: () => ipcRenderer.invoke('is-fullscreen'),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateStatus: (callback: (status: any) => void) => {
    ipcRenderer.on('update-status', (_event, status) => callback(status))
  },
})
