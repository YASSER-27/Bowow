import { make } from './tool'
import { Tools } from './tools'
import { assert as assertPermission } from '../permission/permission'
import { useAppStore } from '../store'

export const name = 'glob_search'

export function register() {
  Tools.register({
    [name]: make({
      description: 'Search for files by filename pattern (glob syntax).',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. src/**/*.py' },
          path: { type: 'string', description: 'Subdirectory to constrain search' },
          limit: { type: 'number', description: 'Max results' },
        },
        required: ['pattern'],
      },
      validate: (input: any): input is { pattern: string; path?: string; limit?: number } =>
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
        const workDir = state.builds[buildId]?.workDir
        if (!workDir || !window.electronAPI) {
          const files = state.builds[buildId]?.projectFiles ?? []
          const regexBody = input.pattern.replace(/\*\*|\*|\?/g, m => m === '**' ? '.*' : m === '*' ? '[^/]*' : '.')
          const regex = new RegExp('^' + regexBody + '$')
          const matches = files.filter(f => regex.test(f.path)).map(f => f.path)
          const listing = matches.length ? matches.join('\n') : '(no matches)'
          return listing
        }
        const dir = input.path ? workDir.replace(/\\/g, '/') + '/' + input.path : workDir.replace(/\\/g, '/')
        const all = await window.electronAPI.readDirRecursive(dir)
        const regexBody = input.pattern.replace(/\*\*|\*|\?/g, m => m === '**' ? '.*' : m === '*' ? '[^/]*' : '.')
        const regex = new RegExp('^' + regexBody + '$')
        const matches = all
          .map(f => f.replace(/\\/g, '/').replace(workDir.replace(/\\/g, '/') + '/', ''))
          .filter(f => regex.test(f))
          .slice(0, input.limit ?? 100)
        return matches.length ? matches.join('\n') : '(no matches)'
      },
    }),
  })
}
