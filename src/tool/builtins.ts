import { register as registerRead } from './read'
import { register as registerEdit } from './edit'
import { register as registerWrite } from './write'
import { register as registerBash } from './bash'
import { register as registerGlob } from './glob'
import { register as registerGrep } from './grep'
import { register as registerTask } from './task'
import { Tools } from './tools'
import { toolRegistry } from './registry'

/** Register all built-in tools. Call once at app startup. */
export function registerBuiltins() {
  registerRead()
  registerEdit()
  registerWrite()
  registerBash()
  registerGlob()
  registerGrep()
  registerTask()
}

export { toolRegistry, Tools }
