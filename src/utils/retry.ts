export interface RetryOptions {
  maxRetries?: number
  initialDelay?: number
  maxDelay?: number
  backoffMultiplier?: number
  jitter?: boolean
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 10,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 1.6,
  jitter: true,
}

function isNetworkError(error: any): boolean {
  return ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(error.code)
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 400 || status === 429 || status === 502 || status === 503 || status === 504
}

function isServerError(error: any): boolean {
  return error.type === 'server_error' || error.type === 'rate_limit_exceeded'
}

function isConnectionError(message: string): boolean {
  return ['premature close', 'premature end', 'connection reset', 'socket hang up', 'aborted', 'overloaded']
    .some(p => message.includes(p))
}

export function isContextLengthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message?.toLowerCase() || ''
  if (msg.includes('invalid_request_error') && msg.includes('context')) return true
  return [
    'input length and max_tokens exceed context limit',
    'decrease input length or max_tokens',
    'maximum context length',
    'reduce the length of the messages',
    'tokens in the prompt exceeds',
    'use a shorter prompt',
    'context_length_exceeded',
  ].some(p => msg.includes(p))
}

export function isRetryableError(error: any): boolean {
  if (isContextLengthError(error)) return false
  if (isNetworkError(error)) return true
  if (error.status && isRetryableHttpStatus(error.status)) return true
  if (isServerError(error)) return true
  const msg = error.message?.toLowerCase()
  if (msg && isConnectionError(msg)) return true
  return false
}

function calculateDelay(attempt: number, options: Required<RetryOptions>): number {
  const base = options.initialDelay * Math.pow(options.backoffMultiplier, attempt)
  const capped = Math.min(base, options.maxDelay)
  if (options.jitter) return Math.floor(capped * (0.5 + Math.random() * 0.5))
  return capped
}

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  abortSignal: AbortSignal,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  let lastError: any

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      if (abortSignal.aborted) throw new Error('Request aborted')
      return await fn(abortSignal)
    } catch (err: any) {
      lastError = err
      if (abortSignal.aborted) throw err
      if (attempt === opts.maxRetries) break
      if (!isRetryableError(err)) throw err
      const delay = calculateDelay(attempt, opts)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastError
}
