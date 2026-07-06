export interface ToolCallDelta {
  id?: string
  type?: string
  function?: {
    name?: string
    arguments?: string
  }
  index?: number
}

export interface ToolCallState {
  id: string
  name: string
  args: string
  parsedArgs: any
  status: 'generating' | 'complete'
}

export function addToolCallDeltaToState(
  delta: ToolCallDelta,
  currentState: ToolCallState | undefined,
): ToolCallState {
  const currentCallId = currentState?.id

  // If we have a current state and the delta has a different ID, ignore
  if (currentState && delta.id && currentCallId !== delta.id) {
    return currentState
  }

  const callId = currentCallId || delta.id || ''
  const currentName = currentState?.name ?? ''
  const currentArgs = currentState?.args ?? ''

  const nameDelta = delta.function?.name ?? ''
  const argsDelta = delta.function?.arguments ?? ''

  // Merge name: handle progressive full-name streaming
  let mergedName = currentName
  if (nameDelta.startsWith(currentName)) {
    // Model sends full name each time but progressive e.g. "readFi" -> "readFil" -> "readFile"
    mergedName = nameDelta
  } else if (!currentName.startsWith(nameDelta)) {
    mergedName = currentName + nameDelta
  }

  // Merge args: handle progressive JSON streaming
  let mergedArgs = currentArgs
  try {
    JSON.parse(currentArgs)
    // Already valid JSON, don't append
  } catch {
    mergedArgs = currentArgs + argsDelta
  }

  let parsedArgs: any = {}
  try {
    parsedArgs = JSON.parse(mergedArgs || '{}')
  } catch {}

  return {
    id: callId,
    name: mergedName,
    args: mergedArgs,
    parsedArgs,
    status: 'generating',
  }
}

export function finalizeToolCallState(state: ToolCallState): ToolCallState {
  return { ...state, status: 'complete' }
}
