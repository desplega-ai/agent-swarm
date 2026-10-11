import type { Agent, AgentTask } from "../../types";
import { isMultiRuntimeEnabled } from "../../utils/multi-runtime";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { workflowEventBus } from "../../workflows/event-bus";
import { canClaim } from "../budget-admission";
import {
  assignUnassignedTaskPending,
  getAllAgents,
  getDbClient,
  getIdleWorkersWithCapacity,
  getTaskById,
  getUnassignedPoolTasks,
  isAgentEligibleForTask,
  MAX_EMPTY_POLLS,
  releaseTask,
} from "../db";
import { type AgentTaskRow, rowToAgentTask } from "../db/tasks/read";
import { poolTaskRunsOnHarness } from "../model-validation";
import { agentsWithLiveRuntime } from "../multi-runtime";
import { listRuntimePools } from "./db";
import { isRuntimePoolWakeable } from "./reachability";

function nonnegativeEnv(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 0 ? n : fallback;
}

export async function routePoolTasks(
  opts: { taskIds?: string[]; now?: Date } = {},
): Promise<Array<{ taskId: string; agentId: string }>> {
  const enabled = isRuntimePoolsEnabled() && isMultiRuntimeEnabled();
  const now = opts.now ?? new Date();
  const pools = enabled ? await listRuntimePools() : [];
  const allAgents = enabled ? await getAllAgents() : [];
  const releasedFrom = new Map<string, string>();
  if (enabled && !opts.taskIds) {
    const pending = await getDbClient().query<AgentTaskRow>(
      "SELECT * FROM agent_tasks WHERE status = 'pending' AND pool_wake_at IS NOT NULL AND COALESCE(routing_reason, '') != 'human_pinned'",
    );
    for (const task of pending.map(rowToAgentTask)) {
      if (!task.poolWakeAt || task.routingReason === "human_pinned") continue;
      const agent = allAgents.find((a) => a.id === task.agentId);
      const pool = pools.find((p) => p.id === agent?.runtimePoolId);
      const expired =
        now.getTime() - Date.parse(task.poolWakeAt) >=
        nonnegativeEnv("RUNTIME_WAKE_REROUTE_SEC", 600) * 1000;
      const circuitOpen =
        pool?.circuitOpenUntil && Date.parse(pool.circuitOpenUntil) > now.getTime();
      if ((expired || circuitOpen) && task.agentId && (await releaseTask(task.id, task)))
        releasedFrom.set(task.id, task.agentId);
    }
  }

  // Runtime liveness stays inert when multi-runtime mode is disabled.
  const withLiveRuntime = enabled || isMultiRuntimeEnabled() ? await agentsWithLiveRuntime() : null;
  // Legacy workers at the empty-poll limit would exit on their next poll.
  const warm = (enabled ? allAgents : await getIdleWorkersWithCapacity()).filter(
    (a) =>
      !a.isLead &&
      a.status !== "offline" &&
      a.status !== "waiting_for_credentials" &&
      (enabled || (a.emptyPollCount ?? 0) < MAX_EMPTY_POLLS) &&
      (withLiveRuntime === null || withLiveRuntime.has(a.id)),
  );
  const wake: Agent[] = [];
  if (enabled) {
    for (const agent of allAgents) {
      if (agent.isLead || agent.status === "waiting_for_credentials" || !agent.runtimePoolId)
        continue;
      const pool = pools.find((p) => p.id === agent.runtimePoolId);
      if (pool && isRuntimePoolWakeable(pool, now)) wake.push(agent);
    }
  }
  if (!warm.length && !wake.length) return [];

  const reserved = new Map<string, number>();
  const headroom = async (agent: Agent): Promise<number> => {
    let count = reserved.get(agent.id);
    if (count === undefined) {
      count =
        (
          await getDbClient().get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM agent_tasks WHERE agentId = ? AND status IN ('pending', 'in_progress')",
            [agent.id],
          )
        )?.count ?? 0;
      reserved.set(agent.id, count);
    }
    return (agent.maxTasks ?? 1) - count;
  };
  const eligible = async (agent: Agent, task: AgentTask): Promise<boolean> =>
    (await headroom(agent)) > 0 &&
    isAgentEligibleForTask(agent, task) &&
    (await poolTaskRunsOnHarness(task, agent.harnessProvider ?? agent.provider ?? null));

  const assigned: Array<{ taskId: string; agentId: string }> = [];
  const limit = nonnegativeEnv("HEARTBEAT_MAX_AUTO_ASSIGN", 5);
  const batchSize = Number(process.env.HEARTBEAT_POOL_SCAN_BATCH_SIZE) || 50;
  const cap = Number(process.env.HEARTBEAT_POOL_SCAN_CAP) || 500;
  let offset = 0;
  let scanned = 0;
  // Page past incompatible tasks to prevent starvation behind the first batch.
  while (assigned.length < limit && scanned < cap) {
    const batch = opts.taskIds
      ? (await Promise.all(opts.taskIds.map((id) => getTaskById(id)))).filter(
          (task): task is AgentTask => task?.status === "unassigned",
        )
      : await getUnassignedPoolTasks(batchSize, offset);
    if (!batch.length) break;
    let assignedInBatch = 0;
    for (const task of batch) {
      if (assigned.length >= limit) break;
      let worker: Agent | undefined;
      let poolWakeAt: string | undefined;
      for (const agent of warm) {
        if (agent.id !== releasedFrom.get(task.id) && (await eligible(agent, task))) {
          worker = agent;
          break;
        }
      }
      if (
        !worker &&
        enabled &&
        now.getTime() - Date.parse(task.createdAt) >=
          nonnegativeEnv("RUNTIME_WAKE_GRACE_SEC", 15) * 1000
      ) {
        const candidates: Array<{ agent: Agent; headroom: number }> = [];
        for (const agent of wake) {
          if (await eligible(agent, task))
            candidates.push({ agent, headroom: await headroom(agent) });
        }
        candidates.sort(
          (a, b) => b.headroom - a.headroom || a.agent.name.localeCompare(b.agent.name),
        );
        for (const { agent } of candidates) {
          // Retry the old agent only if no other eligible wake candidate exists.
          if (agent.id === releasedFrom.get(task.id) && candidates.length > 1) continue;
          if ((await canClaim(agent.id, now, task.requestedByUserId)).allowed) {
            worker = agent;
            poolWakeAt = now.toISOString();
            break;
          }
        }
      }
      if (!worker) continue;
      if (
        await assignUnassignedTaskPending(task.id, worker.id, {
          poolWakeAt,
          routingSnapshot: {
            task,
            agent: worker,
            pool: poolWakeAt ? pools.find((p) => p.id === worker.runtimePoolId) : undefined,
          },
        })
      ) {
        assigned.push({ taskId: task.id, agentId: worker.id });
        reserved.set(worker.id, (reserved.get(worker.id) ?? 0) + 1);
        assignedInBatch++;
      }
    }
    scanned += batch.length;
    // Successful assignments remove rows from the enabled scan, shifting subsequent pages.
    offset += batch.length - (enabled ? assignedInBatch : 0);
    if (opts.taskIds || batch.length < batchSize) break;
  }
  return assigned;
}

let timer: ReturnType<typeof setInterval> | null = null;
let isSweeping = false;
function reportRoutingError(error: unknown): void {
  console.error("[runtime-pools] Routing failed:", scrubSecrets(String(error)));
}
const onTaskAvailable = (data: unknown): void => {
  if (!isRuntimePoolsEnabled() || !isMultiRuntimeEnabled()) return;
  const taskId = (data as { taskId?: unknown } | null)?.taskId;
  if (typeof taskId !== "string") return;
  // Re-read committed state. Creation events do not carry status or offeree.
  void (async () => {
    const task = await getTaskById(taskId);
    if (task?.status === "unassigned") await routePoolTasks({ taskIds: [taskId] });
  })().catch(reportRoutingError);
};

export function startPoolRouting(): void {
  if (timer) return;
  if (isRuntimePoolsEnabled() && !isMultiRuntimeEnabled())
    console.warn("[runtime-pools] Routing requires MULTI_RUNTIME_ENABLED. Using legacy routing.");
  workflowEventBus.on("task.created", onTaskAvailable);
  workflowEventBus.on("task.unassigned", onTaskAvailable);
  timer = setInterval(
    () => {
      if (isSweeping || !isRuntimePoolsEnabled() || !isMultiRuntimeEnabled()) return;
      isSweeping = true;
      void routePoolTasks()
        .catch(reportRoutingError)
        .finally(() => {
          isSweeping = false;
        });
    },
    Math.max(500, nonnegativeEnv("RUNTIME_ROUTING_INTERVAL_MS", 5000) || 5000),
  );
  timer.unref?.();
}

export function stopPoolRouting(): void {
  if (timer) clearInterval(timer);
  timer = null;
  workflowEventBus.off("task.created", onTaskAvailable);
  workflowEventBus.off("task.unassigned", onTaskAvailable);
}
