import { make } from './tool'
import { Tools } from './tools'
import { assert as assertPermission } from '../permission/permission'
import { useAppStore } from '../store'

export const name = 'grep_search'

export function register() {
  Tools.register({
    [name]: make({
      description: 'Search file contents by regex pattern. Returns matching lines with line numbers.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search for in file contents' },
          path: { type: 'string', description: 'Subdirectory or file to constrain search' },
          include: { type: 'string', description: 'File glob filter (e.g. *.ts)' },
          limit: { type: 'number', description: 'Max matches to return' },
        },
        required: ['pattern'],
      },
      validate: (input: any): input is { pattern: string; path?: string; include?: string; limit?: number } =>
        typeof input?.pattern === 'string',
      execute: async (input, context) => {
        await assertPermission({
          action: name,
          resources: [input.pattern],
          save: ['*'],
          sessionID: context.sessionID,
          agent: context.agent,
          source: { type: 'tool', messageID: context.assistantMessageID, callID: context.toolCallID },
        })
        const state = useAppStore.getState()
        const buildId = context.buildId ?? 0
        const regex = new RegExp(input.pattern)
        const files = state.builds[buildId]?.projectFiles ?? []
        const loadIfNeeded = async (f: { path: string; content?: string; contentLoaded?: boolean }) =>
          f.contentLoaded ? f.content || '' : state.loadBuildFileContent(buildId, f.path)
        const limit = input.limit ?? 50
        const results: string[] = []
        for (const file of files) {
          if (input.include) {
            const inc = new RegExp('^' + input.include.replace(/\*|\./g, m => m === '*' ? '.*' : '\\.') + '$')
            if (!inc.test(file.path)) continue
          }
          if (input.path && !file.path.startsWith(input.path)) continue
          if (results.length >= limit) break
          const content = await loadIfNeeded(file)
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= limit) break
            if (regex.test(lines[i])) results.push(`${file.path}:${i + 1}: ${lines[i]}`)
          }
        }
        return results.length ? results.join('\n') : '(no matches)'
      },
    }),
  })
}
