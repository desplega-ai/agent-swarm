import { realtimeBus } from "../realtime/bus";
import { channelTopic, listSubscribedWorkerAgents } from "../realtime/channels";
import type { WorkerNudge } from "../types";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";

export function publishWorkerNudge(
  agentId: string,
  nudge: Pick<WorkerNudge, "kind" | "taskId">,
): void {
  if (!isRuntimePoolsEnabled()) return;
  realtimeBus.publish(channelTopic(`worker:${agentId}`, "nudge"), {
    v: 1,
    ...nudge,
    at: new Date().toISOString(),
  } satisfies WorkerNudge);
}

export function publishWorkerConfigNudge(scope: string, scopeId: string | null): void {
  if (!isRuntimePoolsEnabled()) return;
  const agents = scope === "agent" ? (scopeId ? [scopeId] : []) : listSubscribedWorkerAgents();
  for (const agentId of agents) publishWorkerNudge(agentId, { kind: "config" });
}
