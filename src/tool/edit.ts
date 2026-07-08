import { make, withPermission } from './tool'
import { Tools } from './tools'
import { useAppStore } from '../store'
import { assert as assertPermission } from '../permission/permission'

export const name = 'edit_file'

export function register() {
  Tools.register({
    [name]: withPermission(
      make({
        description: 'Replace specific text in an existing file (str_replace). ' +
          'Each old_str MUST be unique in the file — include enough surrounding lines to guarantee uniqueness. ' +
          'The match is exact: whitespace, indentation, newlines must match precisely. ' +
          'When replace_all is true, all occurrences of old_str will be replaced.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            old_str: { type: 'string', description: 'Text to replace — must be exact including all whitespace' },
            new_str: { type: 'string', description: 'Replacement text (must differ from old_str)' },
            replace_all: { type: 'boolean', description: 'Replace all occurrences of old_str (default false)' },
          },
          required: ['path', 'old_str', 'new_str'],
        },
        validate: (input: any): input is { path: string; old_str: string; new_str: string; replace_all?: boolean } =>
          typeof input?.path === 'string' && typeof input?.old_str === 'string' && typeof input?.new_str === 'string',
        execute: async (input, context) => {
          const buildId = context.buildId ?? 0
          const state = useAppStore.getState()
          const existing = state.builds[buildId]?.projectFiles.find(f => f.path === input.path)
          if (!existing) return `File not found: ${input.path}`
          if (input.old_str === input.new_str) return 'No changes: old_str and new_str are identical.'
          if (!input.old_str) return 'old_str must not be empty.'

          let oldFull = existing.content || ''
          if (!existing.contentLoaded) oldFull = await state.loadBuildFileContent(buildId, input.path)
          const normOld = oldFull.replace(/\r\n/g, '\n')
          const normSearch = input.old_str.replace(/\r\n/g, '\n')
          const count = normOld.split(normSearch).length - 1
          if (count === 0) return 'old_str not found in file. It must match exactly.'
          if (count > 1 && !input.replace_all) return 'Multiple matches found. Set replace_all to true or provide more context.'

          const normNew = input.new_str.replace(/\r\n/g, '\n')
          const replaced = input.replace_all ? normOld.replaceAll(normSearch, normNew) : normOld.replace(normSearch, normNew)
          const newContent = existing.content?.includes('\r\n') ? replaced.replace(/\n/g, '\r\n') : replaced

          state.updateBuildFile(buildId, input.path, newContent)
          if (window.electronAPI?.writeBuildFile) {
            const workDir = state.builds[buildId]?.workDir
            const writePath = workDir ? workDir.replace(/\\/g, '/') + '/' + input.path : input.path
            await window.electronAPI.writeBuildFile({ filePath: writePath, content: newContent })
          }
          return `Edited ${input.path}: ${count} replacement(s) made.`
        },
      }),
      'edit',
    ),
  })
}
