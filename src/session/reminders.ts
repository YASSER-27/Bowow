export interface ReminderConfig {
  planMode?: boolean
  buildSwitch?: boolean
  customReminders?: string[]
}

const DEFAULT_REMINDERS = [
  'Always verify file paths before writing — use the working directory as base.',
  'Use run_command to execute shell commands when needed.',
  'Check for existing implementations before creating new files.',
]

export const buildReminderBlock = (config?: ReminderConfig): string => {
  const items: string[] = []

  if (config?.planMode) {
    items.push('You are in PLAN MODE. Describe the approach and implementation steps before writing code.')
  }

  if (config?.buildSwitch) {
    items.push('The user has switched context. Re-read the latest message carefully before responding.')
  }

  items.push(...DEFAULT_REMINDERS)

  if (config?.customReminders) {
    items.push(...config.customReminders)
  }

  if (items.length === 0) return ''

  return '## Reminders\n' + items.map(r => `- ${r}`).join('\n')
}
