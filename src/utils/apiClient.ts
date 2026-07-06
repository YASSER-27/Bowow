export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: Record<string, unknown> | string
  headers?: Record<string, string>
}

export interface ApiResponse<T = any> {
  data: T
  status: number
  ok: boolean
}

export class ApiRequestError extends Error {
  status: number
  statusText: string
  response?: string

  constructor(status: number, statusText: string, response?: string) {
    const message = response
      ? `API request failed: ${status} ${statusText} - ${response}`
      : `API request failed: ${status} ${statusText}`
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.statusText = statusText
    this.response = response
  }
}

export async function apiRequest<T = any>(
  url: string,
  options: ApiRequestOptions = {},
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  const { method = 'GET', body, headers = {} } = options

  const requestOptions: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    signal,
  }

  if (body) {
    requestOptions.body = typeof body === 'string' ? body : JSON.stringify(body)
  }

  try {
    const response = await fetch(url, requestOptions)

    if (!response.ok) {
      const errorText = await response.text()
      throw new ApiRequestError(response.status, response.statusText, errorText)
    }

    const contentType = response.headers.get('content-type')
    let data: T
    if (contentType && contentType.includes('application/json')) {
      data = await response.json()
    } else {
      data = (await response.text()) as T
    }

    return { data, status: response.status, ok: response.ok }
  } catch (error) {
    if (error instanceof ApiRequestError) throw error
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`Request failed: ${errorMessage}`)
  }
}

export async function get<T = any>(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  return apiRequest<T>(url, { method: 'GET', headers }, signal)
}

export async function post<T = any>(
  url: string,
  body?: Record<string, unknown> | string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  return apiRequest<T>(url, { method: 'POST', body, headers }, signal)
}

export async function put<T = any>(
  url: string,
  body?: Record<string, unknown> | string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  return apiRequest<T>(url, { method: 'PUT', body, headers }, signal)
}

export async function del<T = any>(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal,
): Promise<ApiResponse<T>> {
  return apiRequest<T>(url, { method: 'DELETE', headers }, signal)
}
