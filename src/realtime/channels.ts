export function channelTopic(namespace: string, name: string): string {
  return `channel:${JSON.stringify([namespace, name])}`;
}

const workerSubscribers = new Map<string, Set<object>>();

export function addWorkerSubscription(agentId: string, subscriber: object): void {
  const subscribers = workerSubscribers.get(agentId) ?? new Set<object>();
  subscribers.add(subscriber);
  workerSubscribers.set(agentId, subscribers);
}

export function removeWorkerSubscription(agentId: string, subscriber: object): void {
  const subscribers = workerSubscribers.get(agentId);
  subscribers?.delete(subscriber);
  if (subscribers?.size === 0) workerSubscribers.delete(agentId);
}

export function listSubscribedWorkerAgents(): string[] {
  return [...workerSubscribers.keys()];
}
