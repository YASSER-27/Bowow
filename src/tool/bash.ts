import { make } from './tool'
import { Tools } from './tools'
import { assert as assertPermission } from '../permission/permission'
import { useAppStore } from '../store'

export const name = 'run_command'
const MAX_CAPTURE = 1024 * 1024

export function register() {
  Tools.register({
    [name]: make({
      description: 'Run a shell command in the project directory.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command to execute' },
          cwd: { type: 'string', description: 'Working directory' },
        },
        required: ['command'],
      },
      validate: (input: any): input is { command: string; cwd?: string } =>
        typeof input?.command === 'string',
      execute: async (input, context) => {
        // Prevent destructive commands to secure user's project
        const lowerCmd = input.command.toLowerCase().trim()
        const dangerousPatterns = [
          /\brm\s+-[rf]*\s+\//, // rm -rf /
          /\brmdir\s+\/s\b/,     // Windows rmdir /s
          /\bdel\s+\/f\b/,       // Windows del /f /s /q
          /\bformat\b/,          // Format command
          /\bmkfs\b/,            // Make filesystem
          /\bshred\b/,           // Shred files
        ]

        const isDestructive = dangerousPatterns.some(pattern => pattern.test(lowerCmd))
        if (isDestructive) {
          return `Command Blocked: Running destructive commands like formatting or recursive system directory deletes is restricted for security.`
        }

        await assertPermission({
          action: name,
          resources: [input.command],
          save: [input.command],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: 'tool', messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        if (!window.electronAPI?.runCommand) return 'Shell execution not available.'
        const state = useAppStore.getState()
        const workDir = state.builds[context.buildId ?? 0]?.workDir
        const result = await window.electronAPI.runCommand({
          command: input.command,
          cwd: input.cwd ? (workDir ? workDir + '/' + input.cwd : input.cwd) : workDir ?? undefined,
        })
        const output = (result.stdout + '\n' + result.stderr).trim()
        const truncated = output.length > MAX_CAPTURE ? output.slice(0, MAX_CAPTURE) + '\n... [truncated]' : output
        if (result.exitCode !== 0) return `Command failed (exit ${result.exitCode}):\n${truncated}`
        return truncated || '(no output)'
      },
    }),
  })
}
