import { useEffect, useCallback } from 'react'
import SplitBuildView from './SplitBuildView'
import { useAppStore } from './store'

export default function App() {
  const splitViewEnabled = useAppStore(s => s.splitViewEnabled)

  const toggleSplit = useCallback(() => {
    const store = useAppStore.getState()
    if (store.splitViewEnabled) {
      store.setSplitViewEnabled(false)
      window.electronAPI?.toggleFullScreen()
    } else {
      let currentIds = store.splitPaneBuildIds.filter(id => store.builds[id] !== undefined)
      if (currentIds.length === 0) currentIds = [store.activeBuild ?? 0]
      while (currentIds.length < 4) {
        const newId = Date.now() + Math.random()
        store.addBuild(newId)
        currentIds.push(newId)
      }
      store.setSplitPaneBuildIds(currentIds.slice(0, 4))
      store.setSplitViewEnabled(true)
      window.electronAPI?.toggleFullScreen()
    }
  }, [])

  // F10 global toggle
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'F10' || e.code === 'F10' || e.keyCode === 121) {
        e.preventDefault()
        toggleSplit()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [toggleSplit])

  return (
    <div style={{ width: '100vw', height: '100vh', borderRadius: 10, overflow: 'hidden' }}>
    <div style={{
      width: '100vw', height: '100vh',
      display: 'grid',
      gridTemplateColumns: splitViewEnabled ? '1fr 1fr' : '1fr',
      gridTemplateRows: splitViewEnabled ? '1fr 1fr' : '1fr',
      background: '#121212',
    }}>
      {/* Always render all panes — visibility toggled via CSS, components stay mounted */}
      <SplitBuildView />
    </div>
    </div>
  )
}
