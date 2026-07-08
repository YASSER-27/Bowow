import { make, withPermission } from './tool'
import { Tools } from './tools'
import { useAppStore } from '../store'
import { assert as assertPermission } from '../permission/permission'

export const name = 'create_file'

export function register() {
  Tools.register({
    [name]: withPermission(
      make({
        description: 'Write content to one file. Creates the file if it does not exist.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path to write' },
            content: { type: 'string', description: 'Content to write to the file' },
          },
          required: ['path', 'content'],
        },
        validate: (input: any): input is { path: string; content: string } =>
          typeof input?.path === 'string' && typeof input?.content === 'string',
        execute: async (input, context) => {
          const buildId = context.buildId ?? 0
          const state = useAppStore.getState()
          const existed = !!state.builds[buildId]?.projectFiles.find(f => f.path === input.path)
          state.addBuildFile(buildId, { path: input.path, content: input.content })
          if (window.electronAPI?.writeBuildFile) {
            const workDir = state.builds[buildId]?.workDir
            const writePath = workDir ? workDir.replace(/\\/g, '/') + '/' + input.path : input.path
            await window.electronAPI.writeBuildFile({ filePath: writePath, content: input.content })
          }
          return `${existed ? 'Wrote' : 'Created'} file: ${input.path}`
        },
      }),
      'write',
    ),
  })
}
