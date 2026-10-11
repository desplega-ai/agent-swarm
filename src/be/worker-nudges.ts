import { realtimeBus } from "../realtime/bus";
import { channelTopic, listSubscribedWorkerAgents } from "../realtime/transport";
import type { WorkerNudge } from "../types";
import { isRuntimePoolsEnabled } from "../utils/runtime-pools-flag";
import { workflowEventBus } from "../workflows/event-bus";
import { getDbClient } from "./db/runtime";
import { getTaskById } from "./db/tasks/read";

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

workflowEventBus.on("task.created", (data) => {
  if (!isRuntimePoolsEnabled()) return;
  const taskId = (data as { taskId: string }).taskId;
  getDbClient().afterCommit(async () => {
    const task = await getTaskById(taskId);
    const agentId =
      task?.status === "pending"
        ? task.agentId
        : task?.status === "offered"
          ? task.offeredTo
          : undefined;
    if (agentId) publishWorkerNudge(agentId, { kind: "work", taskId });
  });
});
