let _uniqueId: string | undefined

export function getUniqueId(): string {
  if (!_uniqueId) {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('app_user_id') : null
    if (stored) {
      _uniqueId = stored
    } else {
      _uniqueId = crypto.randomUUID()
      try { localStorage.setItem('app_user_id', _uniqueId) } catch {}
    }
  }
  return _uniqueId
}
