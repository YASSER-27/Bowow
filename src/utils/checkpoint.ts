import { useState, useCallback } from 'react'
import { useAppStore } from '../store'

export interface Checkpoint {
  buildId: number
  path: string
  oldContent: string
  timestamp: number
}

export function useCheckpoint() {
  const [checkpointStack, setCheckpointStack] = useState<Checkpoint[]>([])

  const saveCheckpoint = useCallback((buildId: number, path: string, oldContent: string) => {
    setCheckpointStack(prev => [...prev.slice(-19), { buildId, path, oldContent, timestamp: Date.now() }])
  }, [])

  const undoLastCheckpoint = useCallback(() => {
    const stack = checkpointStack
    if (stack.length === 0) return false
    const last = stack[stack.length - 1]
    const state = useAppStore.getState()
    state.updateBuildFile(last.buildId, last.path, last.oldContent)
    window.electronAPI?.writeBuildFile({ filePath: last.path, content: last.oldContent })
    setCheckpointStack(prev => prev.slice(0, -1))
    return true
  }, [checkpointStack])

  return { checkpointStack, saveCheckpoint, undoLastCheckpoint }
}
