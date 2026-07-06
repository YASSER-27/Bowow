function isIndexInsideCodeBlock(content: string, indexToTest: number): boolean {
  let fenceCount = 0
  let searchPos = 0
  while (searchPos < content.length) {
    const nextFence = content.indexOf('```', searchPos)
    if (nextFence === -1 || nextFence >= indexToTest) break
    fenceCount++
    searchPos = nextFence + 3
  }
  return fenceCount % 2 === 1
}

function findEnclosingCodeBlockStart(content: string, index: number): number {
  if (!isIndexInsideCodeBlock(content, index)) return -1
  let currentSearchPos = 0
  while (currentSearchPos < index) {
    const blockStart = content.indexOf('```', currentSearchPos)
    if (blockStart === -1 || blockStart >= index) break
    const blockEnd = content.indexOf('```', blockStart + 3)
    if (blockStart < index) {
      if (blockEnd === -1 || index < blockEnd + 3) return blockStart
    }
    if (blockEnd === -1) break
    currentSearchPos = blockEnd + 3
  }
  return -1
}

export function findLastSafeSplitPoint(content: string): number {
  const enclosingBlockStart = findEnclosingCodeBlockStart(content, content.length)
  if (enclosingBlockStart !== -1) return enclosingBlockStart

  let searchStartIndex = content.length
  while (searchStartIndex >= 0) {
    const dnlIndex = content.lastIndexOf('\n\n', searchStartIndex)
    if (dnlIndex === -1) break
    const splitPoint = dnlIndex + 2
    if (!isIndexInsideCodeBlock(content, splitPoint)) return splitPoint
    searchStartIndex = dnlIndex - 1
  }

  return content.length
}
