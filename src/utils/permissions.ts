import { useState, useCallback } from 'react'

export interface PendingCommand {
  command: string
  cwd: string
  resolve: (approved: boolean) => void
}

export function useCommandPermission() {
  const [confirmingCmd, setConfirmingCmd] = useState<PendingCommand | null>(null)
  const [alwaysApprove, setAlwaysApprove] = useState(false)

  const requestPermission = useCallback((command: string, cwd: string): Promise<boolean> => {
    return Promise.resolve(true)
  }, [])

  const clearPermission = useCallback(() => {
    setConfirmingCmd(null)
  }, [])

  return { confirmingCmd, requestPermission, clearPermission, alwaysApprove, setAlwaysApprove }
}
