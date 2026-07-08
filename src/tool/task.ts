import { make } from './tool'
import { Tools } from './tools'
import { getAgent, canSpawn, getToolNames, getSystemPrompt } from '../agent/agents'
import { BackgroundJob } from '../agent/background-job'
import { runAgent } from '../agent/runner'
import TOOL_DESCRIPTION from './task.txt'

export const name = 'task'

function renderOutput(input: {
  sessionID: string
  state: 'running' | 'completed' | 'error'
  summary?: string
  text: string
}) {
  const tag = input.state === 'error' ? 'task_error' : 'task_result'
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    '</task>',
  ].join('\n')
}

export async function executeTask(params: {
  description: string
  prompt: string
  subagent_type: string
  background?: boolean
  parentSessionID?: string
  buildId?: number
  apiSettings?: {
    provider: string
    baseUrl: string
    model: string
    apiKeys: Record<string, string>
  }
}) {
  const { description, prompt, subagent_type, background, parentSessionID, buildId, apiSettings } = params

  const agent = getAgent(subagent_type)
  if (!agent) throw new Error(`Unknown agent type: ${subagent_type}`)

  if (parentSessionID && !canSpawn('build', subagent_type)) {
    throw new Error(`Cannot spawn ${subagent_type} from current agent`)
  }

  const sessionID = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const systemPrompt = getSystemPrompt(subagent_type, prompt)
  const toolNames = getToolNames(subagent_type)

  let doneResolve: (info: any) => void = () => {}
  const donePromise = new Promise<any>(resolve => { doneResolve = resolve })

  const metadata = {
    parentSessionID,
    sessionID,
    agent: subagent_type,
    description,
    background: background === true,
  }

  const result = await BackgroundJob.startJob({
    id: sessionID,
    type: 'task',
    title: description,
    metadata,
    run: async (signal) => {
      let fullText = ''
      try {
        await runAgent({
          sessionID,
          agent: subagent_type,
          buildId: buildId ?? 0,
          systemPrompt,
          toolNames,
          apiSettings,
          signal,
          onChunk: (text) => { fullText += text },
        })
        doneResolve({ status: 'completed', output: fullText })
        return fullText
      } catch (err: any) {
        doneResolve({ status: 'error', error: err.message })
        throw err
      }
    },
  })

  if (background) {
    return {
      sessionID,
      state: 'running' as const,
      output: renderOutput({ sessionID, state: 'running', summary: 'Task started', text: 'Working in background...' }),
    }
  }

  const jobResult = await BackgroundJob.waitForJob(sessionID)
  return {
    sessionID,
    state: jobResult.status === 'completed' ? 'completed' as const : 'error' as const,
    output: jobResult.status === 'completed'
      ? renderOutput({ sessionID, state: 'completed', summary: `Task completed: ${description}`, text: jobResult.output || '' })
      : renderOutput({ sessionID, state: 'error', summary: `Task failed: ${description}`, text: jobResult.error || 'Unknown error' }),
  }
}

function register() {
  Tools.register({
    [name]: make({
      description: TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'A short (3-5 words) description of the task' },
          prompt: { type: 'string', description: 'The task for the agent to perform' },
          subagent_type: { type: 'string', description: 'The type of specialized agent to use: explore or general' },
          background: { type: 'boolean', description: 'Run in background (returns immediately, result injected later)' },
        },
        required: ['description', 'prompt', 'subagent_type'],
      },
      validate: (input: any): input is { description: string; prompt: string; subagent_type: string; background?: boolean } =>
        typeof input?.description === 'string' && typeof input?.prompt === 'string' && typeof input?.subagent_type === 'string',
      execute: async (input, context) => {
        const result = await executeTask({
          ...input,
          parentSessionID: context.sessionID,
          buildId: context.buildId,
          apiSettings: (context as any).apiSettings,
        })
        return result.output
      },
    }),
  })
}

export { register }
