export interface RetryableError {
  message: string
  status?: number
  retryAfter?: string
  retryAfterMs?: string
  isRateLimit?: boolean
}

const INITIAL_DELAY = 2000
const BACKOFF_FACTOR = 2
const MAX_DELAY = 30_000

export const delay = (attempt: number, error?: RetryableError): number => {
  if (error?.retryAfterMs) {
    const ms = parseFloat(error.retryAfterMs)
    if (!isNaN(ms)) return Math.min(ms, MAX_DELAY)
  }
  if (error?.retryAfter) {
    const seconds = parseFloat(error.retryAfter)
    if (!isNaN(seconds)) return Math.min(Math.ceil(seconds * 1000), MAX_DELAY)
    const parsed = Date.parse(error.retryAfter) - Date.now()
    if (!isNaN(parsed) && parsed > 0) return Math.min(Math.ceil(parsed), MAX_DELAY)
  }
  return Math.min(INITIAL_DELAY * Math.pow(BACKOFF_FACTOR, attempt - 1), MAX_DELAY)
}

export const isRetryable = (error: RetryableError): boolean => {
  if (error.status === 429) return true
  if (error.status === 503) return true
  if (error.status && error.status >= 500 && error.status < 600) return true
  if (error.message?.toLowerCase().includes('rate limit')) return true
  if (error.message?.toLowerCase().includes('too many requests')) return true
  if (error.message?.toLowerCase().includes('timeout')) return true
  if (error.message?.toLowerCase().includes('internal server error')) return true
  return false
}

export const shouldRetry = (attempt: number, maxRetries: number = 3): boolean =>
  attempt <= maxRetries

export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))
