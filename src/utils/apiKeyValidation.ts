export function isValidAnthropicApiKey(apiKey: string | null | undefined): boolean {
  if (!apiKey || typeof apiKey !== 'string') return false
  return apiKey.startsWith('sk-ant-') && apiKey.length > 'sk-ant-'.length
}

export function getApiKeyValidationError(apiKey: string | null | undefined): string {
  if (!apiKey || typeof apiKey !== 'string') return 'API key is required'
  if (!apiKey.startsWith('sk-ant-')) return 'API key must start with "sk-ant-"'
  if (apiKey.length <= 'sk-ant-'.length) return 'API key is too short'
  return 'Invalid API key format'
}
