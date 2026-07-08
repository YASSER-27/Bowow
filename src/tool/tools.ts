import type { AnyTool } from './tool'

export interface Interface {
  register: (tools: Record<string, AnyTool>) => void
}

/** Narrow registration-only capability exposed to tool implementors. */
export class Tools {
  private static _register: Interface['register'] | null = null

  static init(register: Interface['register']) {
    Tools._register = register
  }

  static register(tools: Record<string, AnyTool>) {
    if (!Tools._register) throw new Error('Tools not initialized')
    Tools._register(tools)
  }
}
