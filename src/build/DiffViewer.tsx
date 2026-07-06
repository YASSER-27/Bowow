import { useEffect, useCallback } from 'react'
import { ColoredDiff } from './ColoredDiff'

interface DiffViewerProps {
  diffContent: string
  onClose: () => void
  fileName?: string
}

export function DiffViewer({ diffContent, onClose, fileName }: DiffViewerProps) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} onClick={onClose}>
      <div style={{
        background: '#111', border: '1px solid #666', borderRadius: 8,
        width: '90vw', maxWidth: 900, maxHeight: '85vh',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }} onClick={e => e.stopPropagation()}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '8px 12px', borderBottom: '1px solid #222',
        }}>
          <span style={{ color: '#888', fontWeight: 600, fontSize: 'var(--font-lg)' }}>
            {fileName ? `Diff — ${fileName}` : 'Diff Viewer'} 
          </span>
          <button onClick={onClose} style={{
            border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 'var(--font-sm)', padding: '0 4px', color: '#f44336'
          }}>✕</button>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
          {diffContent.trim() ? (
            <ColoredDiff diffContent={diffContent} />
          ) : (
            <div style={{ color: '#666', fontStyle: 'italic', padding: 20, textAlign: 'center' }}>
              No changes to display
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
