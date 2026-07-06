import { useRef, useCallback } from 'react'
import { useAppStore } from './store'
import BuildAgent from './build/BuildAgent'

const MAX_PANES = 4

export default function SplitBuildView() {
  const splitViewEnabled = useAppStore(s => s.splitViewEnabled)
  const splitPaneBuildIds = useAppStore(s => s.splitPaneBuildIds)
  const setSplitPaneBuildIds = useAppStore(s => s.setSplitPaneBuildIds)
  const setActiveBuild = useAppStore(s => s.setActiveBuild)
  const addBuild = useAppStore(s => s.addBuild)
  const builds = useAppStore(s => s.builds)
  const activeBuild = useAppStore(s => s.activeBuild)

  const paneBuildIdsRef = useRef(splitPaneBuildIds)
  paneBuildIdsRef.current = splitPaneBuildIds

  const handleNewPane = useCallback(async (paneIndex: number) => {
    if (!window.electronAPI?.selectDirectory) return
    const dir = await window.electronAPI.selectDirectory()
    if (!dir) return
    const newId = Date.now() + Math.random()
    addBuild(newId)
    const store = useAppStore.getState()
    store.setBuildWorkDir(newId, dir)
    const ids = [...paneBuildIdsRef.current]
    ids[paneIndex] = newId
    setSplitPaneBuildIds(ids)
    const files = await window.electronAPI.readDirRecursive(dir)
    for (const rawPath of files) {
      const normalized = rawPath.replace(/\\/g, '/')
      const relPath = normalized.replace(dir.replace(/\\/g, '/') + '/', '')
      if (!relPath || relPath.startsWith('.git/') || relPath.startsWith('node_modules/')) continue
      const content = await window.electronAPI.readFile(rawPath)
      store.addBuildFile(newId, { path: relPath, content })
    }
  }, [addBuild, setSplitPaneBuildIds])

  const handleFocusPane = useCallback((buildId: number) => {
    setActiveBuild(buildId)
  }, [setActiveBuild])

  const paneBuildIds = splitPaneBuildIds.slice(0, MAX_PANES)

  return (
    <>
      {Array.from({ length: MAX_PANES }).map((_, idx) => {
        const buildId = paneBuildIds[idx]
        const build = buildId !== undefined ? builds[buildId] : undefined
        const hasBuild = buildId !== undefined && build !== undefined

        // In single view, only the active build pane is visible
        const isVisible = splitViewEnabled || (!splitViewEnabled && buildId === activeBuild)

        // Empty "new project" placeholder in split view only
        if (!hasBuild) {
          if (splitViewEnabled) {
            return (
              <div key={`empty-${idx}`}
                onClick={() => handleNewPane(idx)}
                style={{
                  background: '#161616',
                  display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center',
                  cursor: 'pointer', gap: 8,
                  border: '1px solid #222',
                }}>
                <div style={{ fontSize: 28, color: '#444' }}>+</div>
                <div style={{ fontSize: 'var(--font-sm)', color: '#555' }}>New Project</div>
              </div>
            )
          }
          return <div key={`empty-${idx}`} style={{ display: 'none' }} />
        }

        // Always same child structure: [header, BuildAgent-wrapper]
        // React reuses BuildAgent by position across view toggles
        return (
          <div key={buildId}
            onClick={() => splitViewEnabled && handleFocusPane(buildId)}
            style={{
              display: isVisible ? 'flex' : 'none',
              flexDirection: 'column',
              overflow: 'hidden',
              border: splitViewEnabled ? (activeBuild === buildId ? '1px solid #888' : '1px solid #222') : 'none',
              position: 'relative',
            }}>
            <div style={{
              height: 22, background: '#1a1a1a', flexShrink: 0,
              display: splitViewEnabled ? 'flex' : 'none',
              alignItems: 'center', justifyContent: 'space-between',
              padding: '0 8px', fontSize: 'var(--font-xs)', color: '#666',
              borderBottom: '1px solid #2a2a2a',
            }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {build?.workDir ? build.workDir.split(/[\\/]/).pop() : `Session ${idx + 1}`}
              </span>
              {activeBuild === buildId && <span style={{ color: '#fff', fontSize: 9 }}>◿</span>}
            </div>
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <BuildAgent buildId={buildId} />
            </div>
          </div>
        )
      })}
    </>
  )
}
