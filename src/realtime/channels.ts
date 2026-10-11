export function channelTopic(namespace: string, name: string): string {
  return `channel:${JSON.stringify([namespace, name])}`;
}

/** Opaque per-socket handle (the ws connection); only identity matters. */
export type WorkerSubscriber = WeakKey;

const workerSubscribers = new Map<string, Set<WorkerSubscriber>>();

export function addWorkerSubscription(agentId: string, subscriber: WorkerSubscriber): void {
  const subscribers = workerSubscribers.get(agentId) ?? new Set<WorkerSubscriber>();
  subscribers.add(subscriber);
  workerSubscribers.set(agentId, subscribers);
}

export function removeWorkerSubscription(agentId: string, subscriber: WorkerSubscriber): void {
  const subscribers = workerSubscribers.get(agentId);
  subscribers?.delete(subscriber);
  if (subscribers?.size === 0) workerSubscribers.delete(agentId);
}

export function listSubscribedWorkerAgents(): string[] {
  return [...workerSubscribers.keys()];
}
