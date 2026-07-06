export function formatError(error: any): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    if (error.message) return error.message
    if (error.error) return formatError(error.error)
    if (error.details) return formatError(error.details)
    if (error.description) return error.description
    if (error.status && error.error && error.error.message)
      return `HTTP ${error.status}: ${error.error.message}`
    if (error.code && error.syscall)
      return `Network error: ${error.code} in ${error.syscall}`
    if (error.errors && Array.isArray(error.errors))
      return error.errors.join(', ')
    try { return JSON.stringify(error) } catch { return `Error: ${Object.prototype.toString.call(error)}` }
  }
  return String(error)
}

export function formatAnthropicError(error: any): string {
  const prefix = 'Anthropic:'
  if (error instanceof Error) {
    if (error.message.includes('authentication_error') && error.message.includes('invalid x-api-key'))
      return `${prefix} Invalid API key`
    return `${prefix} ${error.message}`
  }
  return `${prefix} ${String(error)}`
}
