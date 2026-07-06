const queues = new Map<string, Promise<void>>();

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const currentQueue = queues.get(filePath) ?? Promise.resolve();
  let releaseNext!: () => void;
  const nextQueue = new Promise<void>((resolveQueue) => { releaseNext = resolveQueue; });
  const chainedQueue = currentQueue.then(() => nextQueue);
  queues.set(filePath, chainedQueue);

  await currentQueue;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (queues.get(filePath) === chainedQueue) queues.delete(filePath);
  }
}
