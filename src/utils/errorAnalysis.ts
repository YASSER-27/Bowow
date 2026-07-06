export interface ErrorAnalysis {
  parsedError: string
  statusCode?: number
  message?: string
  providerName?: string
  modelTitle?: string
  helpUrl?: string
  customErrorMessage?: string
  quotaExhausted?: boolean
}

function parseErrorMessage(fullErrMsg: string): string {
  if (!fullErrMsg || typeof fullErrMsg !== 'string' || !fullErrMsg.includes('\n\n')) {
    const single = fullErrMsg?.trim() || ''
    return single
  }
  const msg = fullErrMsg.split('\n\n').slice(1).join('\n\n')
  try {
    const parsed = JSON.parse(msg)
    if (parsed.error !== undefined && parsed.error !== null) {
      return typeof parsed.error === 'object' ? JSON.stringify(parsed.error) : String(parsed.error)
    }
    if (parsed.message !== undefined && parsed.message !== null) {
      return typeof parsed.message === 'object' ? JSON.stringify(parsed.message) : String(parsed.message)
    }
    return msg
  } catch {
    return msg
  }
}

export function analyzeError(error: unknown): ErrorAnalysis {
  const errorMessage = (error as any)?.message
  const parsedError = parseErrorMessage(
    typeof errorMessage === 'string' ? errorMessage : '',
  )

  let message: string | undefined
  let statusCode: number | undefined

  if (
    error &&
    (error instanceof Error || typeof error === 'object') &&
    'message' in error &&
    typeof (error as any).message === 'string'
  ) {
    message = (error as any).message
    const parts = message?.split(' ') ?? []
    if (parts.length === 1) {
      const trimmed = parts[0].trim()
      if (trimmed !== '') {
        const code = Number(trimmed)
        if (!Number.isNaN(code)) statusCode = code
      }
    } else if (parts.length > 1) {
      const status = parts[0] === 'HTTP' ? parts[1] : parts[0]
      if (status) {
        const code = Number(status)
        if (!Number.isNaN(code)) statusCode = code
      }
    }
  }

  let helpUrl: string | undefined
  let customErrorMessage: string | undefined

  const lowerMessage = (message ?? '').toLowerCase()
  const lowerParsedError = parsedError.toLowerCase()
  const errorText = lowerMessage + ' ' + lowerParsedError

  if (
    errorText.includes('incorrect api key') ||
    errorText.includes('invalid api key') ||
    errorText.includes('invalid x-api-key') ||
    errorText.includes('unauthorized')
  ) {
    customErrorMessage = 'Your API key is invalid. Check the API key value in settings.'
  }

  if (errorText.includes('missing bearer') || errorText.includes('missing authentication')) {
    customErrorMessage = 'No API key was sent with the request. Add an API key in settings.'
  }

  const isQuotaExhausted = (statusCode === 429 && (errorText.includes('quota') || errorText.includes('exceeded') || errorText.includes('billing') || errorText.includes('trial') || errorText.includes('usage limit') || errorText.includes('credit limit')))

  if (statusCode === 429 && !isQuotaExhausted) {
    customErrorMessage = 'Rate limited by the API provider. Wait a moment and try again.'
  }

  if (isQuotaExhausted) {
    customErrorMessage = 'API quota has been exhausted. Check your billing at the provider dashboard, or switch to a different API key or model. This error will not be retried automatically.'
  }

  if (statusCode === 402 || errorText.includes('insufficient balance') || errorText.includes('out of credits')) {
    customErrorMessage = 'Your account appears to be out of credits. Add credits to continue.'
  }

  if (statusCode === 404 || errorText.includes('not found') || errorText.includes('model not found')) {
    customErrorMessage = 'Model or endpoint not found. Check the model name and API base URL.'
  }

  if (statusCode === 503 || errorText.includes('overloaded') || errorText.includes('unavailable')) {
    customErrorMessage = 'The API server is overloaded. Auto-retrying...'
  }

  if (statusCode === 401) {
    customErrorMessage = 'Authentication failed. Your API key may be invalid or expired.'
  }

  if (statusCode === 403) {
    customErrorMessage = 'Not authorized to access this model. Check your permissions.'
  }

  if (errorText.includes('error parsing tool call') || errorText.includes('malformed json')) {
    customErrorMessage = 'The model produced an invalid response. The error is usually transient - retrying.'
  }

  return {
    parsedError,
    statusCode,
    message,
    customErrorMessage,
    quotaExhausted: isQuotaExhausted || undefined,
  }
}
