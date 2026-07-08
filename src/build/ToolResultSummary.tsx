import { ColoredDiff } from './ColoredDiff'

const STYLES = {
  arrow: { color: '#666', display: 'flex' as const },
  label: { color: '#666', display: 'flex' as const },
  outputRed: { color: '#f87171' },
  outputWhite: { color: '#ccc' },
  outputDim: { color: '#888' },
}

function getToolDisplayName(name: string): string {
  const map: Record<string, string> = {
    create_file: 'Create File',
    edit_file: 'Edit File',
    read_file: 'Read File',
    run_command: 'Run Command',
    glob_search: 'Glob Search',
    grep_search: 'Grep Search',
    ls: 'List Directory',
  }
  return map[name] || name
}

interface ToolResultSummaryProps {
  toolName?: string
  content: string
}

const MAX_BASH_OUTPUT_LINES = 4

export function ToolResultSummary({ toolName, content }: ToolResultSummaryProps) {
  if (!content) {
    return (
      <div style={STYLES.arrow}>
        <span style={STYLES.label}>⎿  No output</span>
      </div>
    )
  }

  const lines = content.split('\n').length
  const chars = content.length
  const displayName = toolName ? getToolDisplayName(toolName) : 'Tool'

  if ((toolName === 'edit_file') && content.includes('Diff:\n')) {
    const diffSection = content.split('Diff:\n')[1]
    if (diffSection) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', gap: 4 }}>
            <span style={STYLES.arrow}>⎿</span>
            <span style={{ color: '#4ade80' }}>
              {toolName === 'edit_file' ? ' File edited successfully' : ' File written successfully'}
            </span>
          </div>
          <ColoredDiff diffContent={diffSection} />
        </div>
      )
    }
  }

  if (toolName === 'run_command') {
    const isStderr = content.startsWith('Stderr:')
    const actualOutput = isStderr ? content.slice(7).trim() : content
    const outputLines = actualOutput.split('\n')
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          <span style={STYLES.arrow}>⎿</span>
          <span style={STYLES.label}> Terminal output:</span>
        </div>
        <pre style={{
          margin: 0, paddingLeft: 16, fontFamily: 'Consolas, monospace',
          fontSize: 'var(--font-sm)', color: isStderr ? '#f87171' : '#ccc',
          whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto',
          background: '#0a0a0f', borderRadius: 4, padding: '6px 10px', border: '1px solid #1a1a24'
        }}>{actualOutput.trim()}</pre>
      </div>
    )
  }

  // Summary for all other tools
  const getSummary = () => {
    if (content === 'Permission denied by user') return 'Cancelled by user'
    if (content.startsWith('Error')) {
      const l = content.split('\n')
      return `Error: ${l[0]}${l.length > 1 ? '...' : ''}`
    }
    switch (toolName) {
      case 'read_file':
        return content.includes('→') ? `${displayName} (${lines} lines)` : `${displayName} tool output (${lines} lines)`
      case 'create_file':
        return content.includes('Successfully created file') ? 'File created successfully' : 'File updated successfully'
      case 'edit_file':
        return 'File edited successfully'
      case 'glob_search':
      case 'grep_search':
        return `Found ${lines} ${lines === 1 ? 'match' : 'matches'}`
      case 'ls':
        return `Listed ${lines} ${lines === 1 ? 'item' : 'items'}`
      default:
        if (chars > 1000) return `${displayName} output: ${lines} lines, ${chars} chars`
        if (lines > 10) return `${displayName} output: ${lines} lines`
        return content.slice(0, 100) + (content.length > 100 ? '...' : '')
    }
  }

  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <span style={STYLES.arrow}>⎿</span>
      <span style={STYLES.label}> {getSummary()}</span>
    </div>
  )
}
