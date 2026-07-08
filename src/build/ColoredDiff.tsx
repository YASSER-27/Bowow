import { diffWordsWithSpace, type Change } from 'diff'
import { useMemo } from 'react'

const COLORS = {
  ADDITION_BG: '#1a3a1a',
  DELETION_BG: '#3a1a1a',
  ADDITION_HIGHLIGHT: '#2d5a2d',
  DELETION_HIGHLIGHT: '#5a2d2d',
  ADDITION_TEXT: '#4ade80',
  DELETION_TEXT: '#f87171',
  CONTEXT_TEXT: '#888',
  LINE_NUMBER: '#555',
}

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'other'
  oldLine?: number
  newLine?: number
  content: string
}

function parseDiffLines(diffContent: string): DiffLine[] {
  const lines = diffContent.split('\n')
  const result: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const line of lines) {
    if (line.startsWith('+')) {
      newLine++
      result.push({ type: 'add', newLine, content: line.slice(1) })
    } else if (line.startsWith('-')) {
      oldLine++
      result.push({ type: 'del', oldLine, content: line.slice(1) })
    } else if (line.startsWith(' ')) {
      oldLine++
      newLine++
      result.push({ type: 'context', oldLine, newLine, content: line.slice(1) })
    }
    // Skip lines that don't match (+/-/space prefix)
  }
  return result
}

function useWordLevelDiff(oldContent: string, newContent: string) {
  return useMemo(() => diffWordsWithSpace(oldContent, newContent), [oldContent, newContent])
}

function renderWordLevelContent(changes: Change[], showType: 'removed' | 'added'): React.ReactNode[] {
  return changes.map((change, i) => {
    if (showType === 'removed') {
      if (change.removed) {
        return <span key={i} style={{ background: COLORS.DELETION_HIGHLIGHT, borderRadius: 2 }}>{change.value}</span>
      }
      if (!change.added) return <span key={i}>{change.value}</span>
      return null
    }
    if (change.added) {
      return <span key={i} style={{ background: COLORS.ADDITION_HIGHLIGHT, borderRadius: 2 }}>{change.value}</span>
    }
    if (!change.removed) return <span key={i}>{change.value}</span>
    return null
  })
}

interface ColoredDiffProps {
  diffContent: string
  maxLines?: number
}

export function ColoredDiff({ diffContent, maxLines = 50 }: ColoredDiffProps) {
  const parsedLines = parseDiffLines(diffContent)

  if (parsedLines.length === 0) {
    return <div style={{ color: COLORS.CONTEXT_TEXT, fontSize: 'var(--font-md)' }}>No changes detected.</div>
  }

  const truncatedLines = parsedLines.slice(0, maxLines)
  const isTruncated = parsedLines.length > maxLines

  // Group consecutive add/delete lines for word-level diffing
  const groupedLines: Array<{ type: 'group' | 'single'; lines: DiffLine[] }> = []
  let currentGroup: DiffLine[] = []

  for (let i = 0; i < truncatedLines.length; i++) {
    const line = truncatedLines[i]
    const nextLine = truncatedLines[i + 1]

    if (line.type === 'add' || line.type === 'del') {
      currentGroup.push(line)
      if (!nextLine || (nextLine.type !== 'add' && nextLine.type !== 'del')) {
        groupedLines.push(...processGroup(currentGroup))
        currentGroup = []
      }
    } else {
      groupedLines.push({ type: 'single', lines: [line] })
    }
  }

  return (
    <div style={{ fontFamily: 'Consolas, monospace', fontSize: 'var(--font-md)', lineHeight: 1.5 }}>
      {groupedLines.map((group, gi) => {
        if (group.type === 'single') {
          return <SingleLine key={gi} line={group.lines[0]} />
        }
        const delLines = group.lines.filter(l => l.type === 'del')
        const addLines = group.lines.filter(l => l.type === 'add')
        return <WordLevelDiffGroup key={gi} delLines={delLines} addLines={addLines} />
      })}
      {isTruncated && (
        <div style={{ color: COLORS.CONTEXT_TEXT, opacity: 0.7 }}>
          ... ({parsedLines.length - maxLines} more lines)
        </div>
      )}
    </div>
  )
}

function SingleLine({ line }: { line: DiffLine }) {
  const isAdd = line.type === 'add'
  const isDel = line.type === 'del'
  const bg = isAdd ? COLORS.ADDITION_BG : isDel ? COLORS.DELETION_BG : 'transparent'
  const color = isAdd ? COLORS.ADDITION_TEXT : isDel ? COLORS.DELETION_TEXT : COLORS.CONTEXT_TEXT
  const prefix = isAdd ? '+' : isDel ? '-' : ' '
  const lineNum = (line.newLine || line.oldLine || '').toString()
  const dim = line.type === 'context'

  return (
    <div style={{ background: bg, display: 'flex', gap: 0 }}>
      <span style={{ color: COLORS.LINE_NUMBER, minWidth: 32, textAlign: 'right', paddingRight: 4, userSelect: 'none' }}>{lineNum}</span>
      <span style={{ color: COLORS.LINE_NUMBER, minWidth: 12, userSelect: 'none', opacity: 0.5 }}>{prefix}</span>
      <span style={{ color, opacity: dim ? 0.7 : 1, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line.content}</span>
    </div>
  )
}

function WordLevelDiffGroup({ delLines, addLines }: { delLines: DiffLine[]; addLines: DiffLine[] }) {
  const oldContent = delLines.map(l => l.content).join('\n')
  const newContent = addLines.map(l => l.content).join('\n')
  const changes = useWordLevelDiff(oldContent, newContent)

  return (
    <>
      {delLines.map((line, i) => (
        <div key={`del-${i}`} style={{ background: COLORS.DELETION_BG, display: 'flex', gap: 0 }}>
          <span style={{ color: COLORS.LINE_NUMBER, minWidth: 32, textAlign: 'right', paddingRight: 4, userSelect: 'none' }}>
            {(line.oldLine ?? '').toString()}
          </span>
          <span style={{ color: COLORS.LINE_NUMBER, minWidth: 12, userSelect: 'none', opacity: 0.5 }}>-</span>
          <span style={{ color: COLORS.DELETION_TEXT, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {delLines.length === 1 && addLines.length === 1
              ? renderWordLevelContent(changes, 'removed')
              : line.content}
          </span>
        </div>
      ))}
      {addLines.map((line, i) => (
        <div key={`add-${i}`} style={{ background: COLORS.ADDITION_BG, display: 'flex', gap: 0 }}>
          <span style={{ color: COLORS.LINE_NUMBER, minWidth: 32, textAlign: 'right', paddingRight: 4, userSelect: 'none' }}>
            {(line.newLine ?? '').toString()}
          </span>
          <span style={{ color: COLORS.LINE_NUMBER, minWidth: 12, userSelect: 'none', opacity: 0.5 }}>+</span>
          <span style={{ color: COLORS.ADDITION_TEXT, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {delLines.length === 1 && addLines.length === 1
              ? renderWordLevelContent(changes, 'added')
              : line.content}
          </span>
        </div>
      ))}
    </>
  )
}

function processGroup(group: DiffLine[]): Array<{ type: 'group' | 'single'; lines: DiffLine[] }> {
  if (group.length <= 1) return [{ type: 'single', lines: group }]
  const delLines = group.filter(l => l.type === 'del')
  const addLines = group.filter(l => l.type === 'add')
  if (delLines.length > 0 && addLines.length > 0) return [{ type: 'group', lines: group }]
  return group.map(l => ({ type: 'single' as const, lines: [l] }))
}
