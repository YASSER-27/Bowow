export type Hunk =
  | { type: 'add'; path: string; contents: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; movePath?: string; chunks: UpdateFileChunk[] }

export interface UpdateFileChunk {
  oldLines: string[]
  newLines: string[]
  changeContext?: string
  endOfFile?: boolean
}

export interface FileUpdate {
  content: string
}

function stripHeredoc(text: string): string {
  return text.replace(/^[ \t]*\|/gm, '').trim()
}

/**
 * Parse a custom patch format:
 *
 * *** Begin Patch
 * *** Add File: path/to/file
 * +file contents...
 * *** Update File: path/to/file
 * @@ context description
 *  context line
 * -removed line
 * +added line
 * *** Delete File: path/to/file
 * *** End Patch
 */
export function parse(patchText: string): Hunk[] {
  const lines = stripHeredoc(patchText.trim()).split('\n')
  const begin = lines.findIndex(l => l.trim() === '*** Begin Patch')
  const end = lines.findIndex(l => l.trim() === '*** End Patch')
  if (begin === -1 || end === -1 || begin >= end)
    throw new Error('Invalid patch format: missing *** Begin Patch / *** End Patch markers')

  const hunks: Hunk[] = []
  let i = begin + 1

  while (i < end) {
    const line = lines[i]

    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim()
      if (!path) throw new Error('Invalid add file path')
      const parsed = parseAdd(lines, i + 1)
      hunks.push({ type: 'add', path, contents: parsed.content })
      i = parsed.next
      continue
    }

    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim()
      if (!path) throw new Error('Invalid delete file path')
      hunks.push({ type: 'delete', path })
      i++
      continue
    }

    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim()
      if (!path) throw new Error('Invalid update file path')
      let next = i + 1
      let movePath: string | undefined
      if (lines[next]?.startsWith('*** Move to:')) {
        movePath = lines[next]!.slice('*** Move to:'.length).trim()
        if (!movePath) throw new Error('Invalid move file path')
        next++
      }
      const parsed = parseUpdate(lines, next)
      if (parsed.chunks.length === 0)
        throw new Error(`Invalid update hunk for ${path}: expected at least one @@ chunk`)
      hunks.push({ type: 'update', path, movePath, chunks: parsed.chunks })
      i = parsed.next
      continue
    }

    throw new Error(`Invalid patch line: ${line}`)
  }

  return hunks
}

function parseAdd(lines: string[], start: number): { content: string; next: number } {
  const content: string[] = []
  let i = start
  while (i < lines.length && !lines[i].startsWith('***')) {
    if (!lines[i].startsWith('+')) throw new Error(`Invalid add file line: ${lines[i]}`)
    content.push(lines[i].slice(1))
    i++
  }
  return { content: content.join('\n'), next: i }
}

function parseUpdate(lines: string[], start: number): { chunks: UpdateFileChunk[]; next: number } {
  const chunks: UpdateFileChunk[] = []
  let i = start
  while (i < lines.length && !lines[i].startsWith('***')) {
    if (!lines[i].startsWith('@@'))
      throw new Error(`Invalid update file line: ${lines[i]}`)
    const changeContext = lines[i].slice(2).trim() || undefined
    const oldLines: string[] = []
    const newLines: string[] = []
    let endOfFile = false
    i++
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const line = lines[i]
      if (line === '*** End of File') { endOfFile = true; i++; break }
      if (line.startsWith('***')) break
      if (line.startsWith(' ')) { oldLines.push(line.slice(1)); newLines.push(line.slice(1)); i++; continue }
      if (line.startsWith('-')) { oldLines.push(line.slice(1)); i++; continue }
      if (line.startsWith('+')) { newLines.push(line.slice(1)); i++; continue }
      throw new Error(`Invalid hunk line: ${line}`)
    }
    chunks.push({ oldLines, newLines, changeContext, endOfFile })
  }
  return { chunks, next: i }
}

/**
 * Apply update chunks to original file content.
 */
export function derive(path: string, chunks: UpdateFileChunk[], original: string): FileUpdate {
  const lines = original.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const replacements = computeReplacements(lines, chunks)
  const updated = [...lines]
  for (const [start, remove, insert] of replacements.toReversed())
    updated.splice(start, remove, ...insert)
  if (updated.at(-1) !== '') updated.push('')
  return { content: updated.join('\n') }
}

function computeReplacements(
  lines: string[],
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = []
  let searchStart = 0

  for (const chunk of chunks) {
    if (chunk.endOfFile) {
      replacements.push([lines.length, 0, chunk.newLines])
      continue
    }
    const oldLines = chunk.oldLines
    if (oldLines.length === 0) {
      replacements.push([searchStart, 0, chunk.newLines])
      continue
    }
    // Find the first matching position
    let found = -1
    for (let i = searchStart; i <= lines.length - oldLines.length; i++) {
      let match = true
      for (let j = 0; j < oldLines.length; j++) {
        if (lines[i + j] !== oldLines[j]) { match = false; break }
      }
      if (match) { found = i; break }
    }
    if (found === -1)
      throw new Error(`Patch hunk not found in ${path}:\n  ${oldLines.slice(0, 3).join('\n  ')}`)
    replacements.push([found, oldLines.length, chunk.newLines])
    searchStart = found + chunk.newLines.length
  }

  return replacements
}

/**
 * Serialize hunks back into patch text.
 */
export function serialize(hunks: Hunk[]): string {
  const parts = ['*** Begin Patch']
  for (const hunk of hunks) {
    if (hunk.type === 'add') {
      parts.push(`*** Add File: ${hunk.path}`)
      for (const line of hunk.contents.split('\n')) parts.push(`+${line}`)
    } else if (hunk.type === 'delete') {
      parts.push(`*** Delete File: ${hunk.path}`)
    } else if (hunk.type === 'update') {
      parts.push(`*** Update File: ${hunk.path}`)
      if (hunk.movePath) parts.push(`*** Move to: ${hunk.movePath}`)
      for (const chunk of hunk.chunks) {
        parts.push(`@@${chunk.changeContext ? ' ' + chunk.changeContext : ''}`)
        for (const line of chunk.oldLines) {
          if (chunk.newLines.includes(line)) parts.push(` ${line}`)
          else parts.push(`-${line}`)
        }
        for (const line of chunk.newLines) {
          if (!chunk.oldLines.includes(line)) parts.push(`+${line}`)
        }
        if (chunk.endOfFile) parts.push('*** End of File')
      }
    }
  }
  parts.push('*** End Patch')
  return parts.join('\n')
}

/**
 * Compute hunks by comparing old and new content.
 */
export function compute(oldContent: string, newContent: string, path: string): Hunk {
  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')

  if (oldLines.length === 0) {
    return { type: 'add', path, contents: newContent }
  }

  // Simple LCS-based diff for hunk computation
  const chunks: UpdateFileChunk[] = []
  const lcs = computeLCS(oldLines, newLines)
  let oi = 0, ni = 0, li = 0

  while (oi < oldLines.length || ni < newLines.length) {
    const common = lcs[li]
    if (common && oldLines[oi] === common && newLines[ni] === common) {
      oi++; ni++; li++
      continue
    }
    // Start of a diff
    const oldDiff: string[] = []
    const newDiff: string[] = []
    while (
      (oi < oldLines.length || ni < newLines.length) &&
      !(common && oldLines[oi] === common && newLines[ni] === common)
    ) {
      if (ni < newLines.length && (oi >= oldLines.length || oldLines[oi] !== common)) {
        newDiff.push(newLines[ni]); ni++
      } else if (oi < oldLines.length) {
        oldDiff.push(oldLines[oi]); oi++
      }
    }
    if (oldDiff.length > 0 || newDiff.length > 0)
      chunks.push({ oldLines: oldDiff, newLines: newDiff })
  }

  return { type: 'update', path, chunks }
}

function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length, n = b.length
  if (m * n > 1_000_000) return [] // fallback for large files
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1])
  const result: string[] = []
  let i = m, j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { result.unshift(a[i - 1]); i--; j-- }
    else if (dp[i - 1][j] > dp[i][j - 1]) i--
    else j--
  }
  return result
}
