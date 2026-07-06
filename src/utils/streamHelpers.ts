export type ToolStatus = 'calling' | 'generated' | 'done' | 'errored' | 'canceled'

export interface StreamCallbacks {
  onContent?: (delta: string) => void
  onContentComplete?: (content: string) => void
  onToolStart?: (toolName: string, toolArgs: any) => void
  onToolResult?: (result: string, toolName: string, status: ToolStatus) => void
  onToolError?: (error: string, toolName?: string) => void
}

export function createStreamHandlers(callbacks: StreamCallbacks) {
  return {
    handleDelta: (delta: any) => {
      if (delta.type === 'content' && delta.text) {
        callbacks.onContent?.(delta.text)
      }
      if (delta.type === 'tool_call' && delta.name) {
        callbacks.onToolStart?.(delta.name, delta.arguments)
      }
    },
    handleDone: (content: string, toolResults?: Array<{ name: string; result: string; status: ToolStatus }>) => {
      callbacks.onContentComplete?.(content)
      if (toolResults) {
        for (const tr of toolResults) {
          if (tr.status === 'errored') {
            callbacks.onToolError?.(tr.result, tr.name)
          } else {
            callbacks.onToolResult?.(tr.result, tr.name, tr.status)
          }
        }
      }
    },
    handleError: (error: string, toolName?: string) => {
      callbacks.onToolError?.(error, toolName)
    },
  }
}
