import { validateName, type AnyTool } from './tool'

interface Entry {
  identity: object
  tool: AnyTool
}

export class ApplicationTools {
  private entries = new Map<string, Entry>()

  register(tools: Record<string, AnyTool>): void {
    for (const name of Object.keys(tools)) validateName(name)
    for (const [name, tool] of Object.entries(tools)) {
      this.entries.set(name, { identity: {}, tool })
    }
  }

  getEntries(): ReadonlyMap<string, Entry> {
    return this.entries
  }
}

export const applicationTools = new ApplicationTools()
