export type AgentMode = 'primary' | 'subagent' | 'all'

export interface AgentInfo {
  name: string
  description: string
  mode: AgentMode
  systemPrompt?: string
  color?: string
  steps?: number
  permissions: string[]
  hidden?: boolean
}

const AGENTS: Record<string, AgentInfo> = {
  build: {
    name: 'build',
    description: 'Main build agent - creates and edits files, runs commands',
    mode: 'primary',
    color: '#4ade80',
    steps: 30,
    permissions: ['read', 'edit', 'write', 'glob', 'grep', 'bash', 'task'],
  },
  plan: {
    name: 'plan',
    description: 'Plan agent - analyzes requirements and produces a plan',
    mode: 'primary',
    color: '#facc15',
    steps: 10,
    permissions: ['read', 'glob', 'grep', 'bash', 'task'],
  },
  explore: {
    name: 'explore',
    description: 'Fast codebase explorer - use for searching files, reading code, answering questions about the codebase',
    mode: 'subagent',
    systemPrompt: `You are a fast codebase exploration agent.
Your job is to quickly find information in the codebase using grep, glob, and read tools.
Be thorough but fast. Return a concise summary of what you found.
Do NOT modify any files.`,
    color: '#60a5fa',
    steps: 10,
    permissions: ['read', 'glob', 'grep', 'bash'],
  },
  general: {
    name: 'general',
    description: 'General-purpose agent for complex multi-step tasks',
    mode: 'subagent',
    systemPrompt: `You are a general-purpose agent that handles multi-step tasks autonomously.
You have access to all tools. Complete the task thoroughly and return the result.`,
    color: '#a78bfa',
    steps: 20,
    permissions: ['read', 'edit', 'write', 'glob', 'grep', 'bash'],
  },
}

export function getAgent(name: string): AgentInfo | undefined {
  return AGENTS[name]
}

export function listAgents(mode?: AgentMode): AgentInfo[] {
  const all = Object.values(AGENTS).filter(a => !a.hidden)
  if (mode) return all.filter(a => a.mode === mode || a.mode === 'all')
  return all
}

export function getSystemPrompt(agent: string, userPrompt?: string): string {
  const info = AGENTS[agent]
  if (!info) return userPrompt || ''
  const parts: string[] = []
  if (info.systemPrompt) parts.push(info.systemPrompt)
  if (userPrompt) parts.push(userPrompt)
  return parts.join('\n\n')
}

export function getToolNames(agent: string): string[] {
  const info = AGENTS[agent]
  return info?.permissions ?? ['read', 'glob', 'grep', 'bash']
}

export function canSpawn(parentAgent: string, childAgent: string): boolean {
  const parent = AGENTS[parentAgent]
  if (!parent) return false
  if (!parent.permissions.includes('task')) return false
  const child = AGENTS[childAgent]
  if (!child) return false
  return child.mode === 'subagent' || child.mode === 'all'
}

export * as Agents from './agents'
