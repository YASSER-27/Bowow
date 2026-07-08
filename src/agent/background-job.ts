export type JobStatus = 'running' | 'completed' | 'error' | 'cancelled'

export interface JobInfo {
  id: string
  type: string
  title?: string
  status: JobStatus
  startedAt: number
  completedAt?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

interface ActiveJob {
  info: JobInfo
  done: { resolve: (info: JobInfo) => void; promise: Promise<JobInfo> }
  cancel: () => void
}

const jobs = new Map<string, ActiveJob>()

export function listJobs(): JobInfo[] {
  return Array.from(jobs.values()).map(j => ({ ...j.info })).sort((a, b) => a.startedAt - b.startedAt)
}

export function getJob(id: string): JobInfo | undefined {
  const job = jobs.get(id)
  return job ? { ...job.info } : undefined
}

export async function startJob(input: {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  run: (signal: AbortSignal) => Promise<string>
  onCancel?: () => void
}): Promise<JobInfo> {
  const id = input.id ?? `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const existing = jobs.get(id)
  if (existing && existing.info.status === 'running') return { ...existing.info }

  const abortController = new AbortController()
  let doneResolve: (info: JobInfo) => void = () => {}
  const donePromise = new Promise<JobInfo>(resolve => { doneResolve = resolve })

  const info: JobInfo = {
    id,
    type: input.type,
    title: input.title,
    status: 'running',
    startedAt: Date.now(),
    metadata: input.metadata,
  }
  const job: ActiveJob = { info, done: { resolve: doneResolve, promise: donePromise }, cancel: () => abortController.abort() }
  jobs.set(id, job)

  input.run(abortController.signal)
    .then(output => {
      const completed: JobInfo = { ...info, status: 'completed', completedAt: Date.now(), output }
      job.info = completed
      doneResolve(completed)
    })
    .catch(err => {
      if (abortController.signal.aborted) {
        const cancelled: JobInfo = { ...info, status: 'cancelled', completedAt: Date.now() }
        job.info = cancelled
        doneResolve(cancelled)
      } else {
        const error: JobInfo = { ...info, status: 'error', completedAt: Date.now(), error: err instanceof Error ? err.message : String(err) }
        job.info = error
        doneResolve(error)
      }
    })

  return { ...info }
}

export async function waitForJob(id: string, timeout?: number): Promise<JobInfo> {
  const job = jobs.get(id)
  if (!job) return { id, type: '', status: 'completed', startedAt: 0 }
  if (job.info.status !== 'running') return { ...job.info }

  if (timeout !== undefined && timeout > 0) {
    const result = await Promise.race([
      job.done.promise,
      new Promise<null>(resolve => setTimeout(() => resolve(null), timeout)),
    ])
    if (result === null) return { ...job.info }
    return result
  }

  return await job.done.promise
}

export function cancelJob(id: string): JobInfo | undefined {
  const job = jobs.get(id)
  if (!job) return undefined
  job.cancel()
  return { ...job.info }
}

export function cancelAllJobs(): void {
  for (const [id] of jobs) cancelJob(id)
}

export * as BackgroundJob from './background-job'
