/** Configuration system adapted from opencode's Config.
 *  Discovers bowow.json/bowow.jsonc by walking up from the project directory.
 *  Global config at ~/.config/bowow/ + project config + .bowow/ directory overrides.
 */

export interface BowowConfig {
  shell?: string
  model?: string
  default_agent?: string
  permissions?: { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }[]
  agents?: Record<string, { model?: string; system_prompt?: string; steps?: number }>
  commands?: Record<string, { command: string; description?: string }>
  experimental?: Record<string, any>
}

interface ConfigEntry {
  type: 'document' | 'directory'
  path?: string
  info?: BowowConfig
}

/** Discover configs by walking up from startDir looking for bowow.json/bowow.jsonc */
export async function discoverConfigs(startDir: string): Promise<ConfigEntry[]> {
  const entries: ConfigEntry[] = []

  // 1. Global config
  if (typeof process !== 'undefined' && process.env?.HOME) {
    const globalDir = process.env.HOME + '/.config/bowow'
    try {
      const global = await loadConfigFile(globalDir + '/bowow.json')
      if (global) entries.push({ type: 'document', path: globalDir + '/bowow.json', info: global })
    } catch {}
  }

  // 2. Walk up from startDir
  let current = startDir.replace(/\\/g, '/')
  const parts = current.split('/')
  const discovered: { path: string; info: BowowConfig; depth: number }[] = []

  for (let i = parts.length; i >= 1; i--) {
    const dir = parts.slice(0, i).join('/')
    try {
      const config = await loadConfigFile(dir + '/bowow.json')
      if (config) discovered.push({ path: dir + '/bowow.json', info: config, depth: i })
    } catch {}
    try {
      const config = await loadConfigFile(dir + '/bowow.jsonc')
      if (config) discovered.push({ path: dir + '/bowow.jsonc', info: config, depth: i })
    } catch {}
    // .bowow/ directory config
    try {
      const config = await loadConfigFile(dir + '/.bowow/bowow.json')
      if (config) discovered.push({ path: dir + '/.bowow/bowow.json', info: config, depth: i })
    } catch {}
  }

  // Sort by depth descending (closer to start wins)
  discovered.sort((a, b) => b.depth - a.depth)
  for (const item of discovered) {
    entries.push({ type: 'document', path: item.path, info: item.info })
  }

  return entries
}

async function loadConfigFile(filepath: string): Promise<BowowConfig | null> {
  if (window.electronAPI?.readFile) {
    try {
      const text = await window.electronAPI.readFile(filepath)
      if (!text) return null
      return JSON.parse(text) as BowowConfig
    } catch {
      return null
    }
  }
  return null
}

/** Merge config entries with later entries having priority. */
export function mergeConfigs(entries: ConfigEntry[]): BowowConfig {
  const merged: BowowConfig = {}
  for (const entry of entries) {
    if (entry.type !== 'document' || !entry.info) continue
    const info = entry.info
    if (info.shell) merged.shell = info.shell
    if (info.model) merged.model = info.model
    if (info.default_agent) merged.default_agent = info.default_agent
    if (info.permissions) merged.permissions = [...(merged.permissions || []), ...info.permissions]
    if (info.agents) merged.agents = { ...merged.agents, ...info.agents }
    if (info.commands) merged.commands = { ...merged.commands, ...info.commands }
    if (info.experimental) merged.experimental = { ...merged.experimental, ...info.experimental }
  }
  return merged
}

/** Load config for a given directory and apply to the store */
export async function applyConfig(dir: string) {
  try {
    const entries = await discoverConfigs(dir)
    const merged = mergeConfigs(entries)
    return merged
  } catch {
    return null
  }
}
