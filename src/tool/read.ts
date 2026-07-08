import { make } from './tool'
import { Tools } from './tools'
import { useAppStore } from '../store'
import { assert as assertPermission } from '../permission/permission'

export const name = 'read_file'

async function execute(input: { path: string; start_line?: number; end_line?: number }, context: { buildId?: number }) {
  const buildId = context.buildId ?? 0
  const state = useAppStore.getState()
  const content = await state.loadBuildFileContent(buildId, input.path)
  if (!content && !state.builds[buildId]?.projectFiles.find(f => f.path === input.path)) {
    return `File not found: ${input.path}`
  }
  const lines = (content || '').split('\n')
  
  // If the file is very large and no start/end lines are provided, limit to first 100 lines and advise
  const totalLines = lines.length
  let start = input.start_line ? Math.max(1, input.start_line) - 1 : 0
  let end = input.end_line ? Math.min(totalLines, input.end_line) : totalLines
  
  let appendWarning = ''
  if (!input.start_line && !input.end_line && totalLines > 150) {
    end = 100
    appendWarning = `\n\n[NOTE: File is large (${totalLines} lines). Showing lines 1-100 to save context limit. Use start_line=101 and end_line=${totalLines} in read_file to read more.]`
  }

  const fileContent = lines.slice(start, end).join('\n')
  return fileContent + appendWarning
}

export function register() {
  Tools.register({
    [name]: make({
      description: 'Read the content of an existing file. ALWAYS use this before editing a file you have not just created yourself in this conversation. You can optionally specify start_line and end_line to read specific sections of large files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start_line: { type: 'number', description: 'Optional line number to start reading from (1-indexed)' },
          end_line: { type: 'number', description: 'Optional line number to end reading at (1-indexed, inclusive)' },
        },
        required: ['path'],
      },
      validate: (input: any): input is { path: string; start_line?: number; end_line?: number } =>
        typeof input?.path === 'string',
      execute,
    }),
  })
}

/** Direct execution without permission (used internally by execTool) */
export async function executeDirect(input: { path: string; start_line?: number; end_line?: number }, buildId: number) {
  return execute(input, { buildId })
}
