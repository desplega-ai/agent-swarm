const runtimeCounters = globalThis as typeof globalThis & {
  __agentSwarmServerSessionsProcessed?: number;
};

export function incrementServerSessionsProcessed(): void {
  runtimeCounters.__agentSwarmServerSessionsProcessed =
    (runtimeCounters.__agentSwarmServerSessionsProcessed ?? 0) + 1;
}

export function getServerSessionsProcessed(): number {
  return runtimeCounters.__agentSwarmServerSessionsProcessed ?? 0;
}
