import type { Agent, AgentTask } from "../../types";
import { isMultiRuntimeEnabled } from "../../utils/multi-runtime";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { workflowEventBus } from "../../workflows/event-bus";
import { canClaim } from "../budget-admission";
import {
  assignUnassignedTaskPending,
  createLogEntry,
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
import { checkProfileForAgent, runtimeReadsRepoSecrets } from "../model-profile-check";
import { poolTaskRunsOnHarness } from "../model-validation";
import {
  agentsWithLiveRuntime,
  liveRuntimeAuthModes,
  runtimeStaleThresholdMinutes,
} from "../multi-runtime";
import { listRuntimePools } from "./db";
import { isRuntimePoolWakeable } from "./reachability";

function nonnegativeEnv(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  const n = Number(raw);
  return raw && Number.isInteger(n) && n >= 0 ? n : fallback;
}

async function eligibleRuntimeSlots(agentId?: string): Promise<Map<string, number>> {
  const runtimes = await getDbClient().query<{ agent_id: string; free_slots: number }>(
    `SELECT r.agent_id, SUM(MAX(0, r.reported_slots - MAX(
       (SELECT COUNT(*) FROM active_sessions WHERE runtimeInstanceId = r.id),
       CASE WHEN t.status IN ('in_progress', 'reviewing') THEN 1 ELSE 0 END
     ))) AS free_slots
     FROM runtime_instances r JOIN agents a ON a.id = r.agent_id
     LEFT JOIN runtime_pools p ON p.id = a.runtime_pool_id
     LEFT JOIN agent_tasks t ON t.id = r.task_id
     WHERE r.status = 'active' AND r.draining = 0
       AND (r.credential_ready IS NULL OR r.credential_ready = 1)
       AND r.last_seen_at >= ?
       AND (a.runtime_pool_id IS NULL OR p.enabled = 1)
       AND (COALESCE(p.lifecycle, 'idle') != 'per-task' OR t.id IS NULL
         OR t.status NOT IN ('completed', 'failed', 'cancelled', 'superseded'))
       ${agentId ? "AND r.agent_id = ?" : ""}
     GROUP BY r.agent_id`,
    [
      new Date(Date.now() - runtimeStaleThresholdMinutes() * 60000).toISOString(),
      ...(agentId ? [agentId] : []),
    ],
  );
  return new Map(runtimes.map((runtime) => [runtime.agent_id, runtime.free_slots]));
}

export async function routePoolTasks(
  opts: { taskIds?: string[]; now?: Date } = {},
): Promise<Array<{ taskId: string; agentId: string }>> {
  const enabled = isRuntimePoolsEnabled() && isMultiRuntimeEnabled();
  const now = opts.now ?? new Date();
  const pools = enabled ? await listRuntimePools() : [];
  const allAgents = enabled ? await getAllAgents() : [];
  const runtimeSlots = enabled ? await eligibleRuntimeSlots() : new Map<string, number>();
  const provisioning = new Set<string>();
  if (enabled && !opts.taskIds) {
    const starting = await getDbClient().query<{ agent_id: string }>(
      "SELECT DISTINCT agent_id FROM runtime_instances WHERE status = 'provisioning' AND draining = 0",
    );
    for (const runtime of starting) provisioning.add(runtime.agent_id);
  }
  const releasedFrom = new Map<string, string>();
  if (enabled && !opts.taskIds) {
    const pending = await getDbClient().query<AgentTaskRow>(
      `SELECT * FROM agent_tasks WHERE status = 'pending'
       AND (pool_wake_at IS NOT NULL OR agentId IN (
         SELECT id FROM agents WHERE runtime_pool_id IS NOT NULL
         UNION SELECT agent_id FROM runtime_instances WHERE pool_id IS NOT NULL
       )) AND COALESCE(routing_reason, '') != 'human_pinned'`,
    );
    for (const task of pending.map(rowToAgentTask)) {
      const agent = allAgents.find((a) => a.id === task.agentId);
      const pool = pools.find((p) => p.id === agent?.runtimePoolId);
      const expired =
        task.poolWakeAt &&
        now.getTime() - Date.parse(task.poolWakeAt) >=
          nonnegativeEnv("RUNTIME_WAKE_REROUTE_SEC", 600) * 1000;
      const circuitOpen =
        task.poolWakeAt &&
        pool?.circuitOpenUntil &&
        Date.parse(pool.circuitOpenUntil) > now.getTime();
      const stranded =
        !task.poolWakeAt &&
        (!pool || !isRuntimePoolWakeable(pool, now)) &&
        !runtimeSlots.has(task.agentId!) &&
        !provisioning.has(task.agentId!);
      if (!(expired || circuitOpen || stranded) || !task.agentId) continue;
      if (task.poolWakeAt) {
        if (await releaseTask(task.id, task)) releasedFrom.set(task.id, task.agentId);
      } else {
        // The sweep routes this release itself, without an independent routing event.
        const released = await getDbClient().run(
          `UPDATE agent_tasks SET agentId = NULL, status = 'unassigned', lastUpdatedAt = ?
           WHERE id = ? AND status = 'pending' AND agentId = ? AND pool_wake_at IS NULL
             AND COALESCE(routing_reason, '') != 'human_pinned'`,
          [new Date().toISOString(), task.id, task.agentId],
        );
        if (released.changes) {
          releasedFrom.set(task.id, task.agentId);
          try {
            await createLogEntry({
              eventType: "task_released",
              agentId: task.agentId,
              taskId: task.id,
              oldValue: "pending",
              newValue: "unassigned",
            });
          } catch {}
        }
      }
    }
  }

  // Runtime liveness stays inert when multi-runtime mode is disabled.
  const withLiveRuntime = enabled
    ? new Set(runtimeSlots.keys())
    : isMultiRuntimeEnabled()
      ? await agentsWithLiveRuntime()
      : null;
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
      const occupied = await getDbClient().get<{ count: number; pending: number }>(
        `SELECT COUNT(*) AS count, COALESCE(SUM(status = 'pending'), 0) AS pending
         FROM agent_tasks WHERE agentId = ? AND status IN ('pending', 'in_progress')`,
        [agent.id],
      );
      count = occupied?.count ?? 0;
      reserved.set(agent.id, count);
      if (runtimeSlots.has(agent.id))
        runtimeSlots.set(agent.id, runtimeSlots.get(agent.id)! - (occupied?.pending ?? 0));
    }
    return (agent.maxTasks ?? 1) - count;
  };
  // A task with an explicit `profile` waits for an agent that passes the profile
  // check, as on the poll's unassigned scan. Memoized per pass. A runtime token's
  // config read may omit secret repo rows while a shared-key runtime reads them,
  // so judge the config each runtime that could start the task gets: every live
  // runtime, plus the token a woken runtime is minted for a wake.
  const runtimeAuthModes = withLiveRuntime === null ? null : await liveRuntimeAuthModes();
  const secretViews = (agent: Agent, viaWake: boolean): boolean[] => {
    if (runtimeAuthModes === null) return [true];
    const tokenView = runtimeReadsRepoSecrets(agent);
    const views = (runtimeAuthModes.get(agent.id) ?? []).map((runtimeToken) =>
      runtimeToken ? tokenView : true,
    );
    if (viaWake || !views.length) views.push(tokenView);
    return [...new Set(views)];
  };
  const profileOk = new Map<string, boolean>();
  const passesProfileCheck = async (
    agent: Agent,
    task: AgentTask,
    viaWake: boolean,
  ): Promise<boolean> => {
    if (!task.profile) return true;
    for (const includeRepoSecrets of secretViews(agent, viaWake)) {
      const memoKey = JSON.stringify([
        agent.id,
        task.profile,
        task.vcsRepo ?? null,
        includeRepoSecrets,
      ]);
      let ok = profileOk.get(memoKey);
      if (ok === undefined) {
        const result = await checkProfileForAgent(agent.id, task.profile, {
          vcsRepo: task.vcsRepo,
          includeRepoSecrets,
        });
        ok = result?.ok !== false;
        profileOk.set(memoKey, ok);
      }
      if (!ok) return false;
    }
    return true;
  };
  const eligible = async (agent: Agent, task: AgentTask, viaWake = false): Promise<boolean> =>
    (await headroom(agent)) > 0 &&
    isAgentEligibleForTask(agent, task) &&
    (await poolTaskRunsOnHarness(task, agent.harnessProvider ?? agent.provider ?? null)) &&
    (await passesProfileCheck(agent, task, viaWake));

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
        if (
          agent.id !== releasedFrom.get(task.id) &&
          (await eligible(agent, task)) &&
          (!enabled || (runtimeSlots.get(agent.id) ?? 0) > 0)
        ) {
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
          if (await eligible(agent, task, true))
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
      const assignmentOptions = {
        poolWakeAt,
        routingSnapshot: {
          task,
          agent: worker,
          pool: poolWakeAt ? pools.find((p) => p.id === worker.runtimePoolId) : undefined,
        },
      };
      const workerId = worker.id;
      const assignment =
        enabled && !poolWakeAt
          ? await getDbClient().transaction(async (tx) => {
              // Recheck physical capacity under the assignment's write lock.
              const slots = (await eligibleRuntimeSlots(workerId)).get(workerId) ?? 0;
              const pending = await tx.get<{ count: number }>(
                "SELECT COUNT(*) AS count FROM agent_tasks WHERE agentId = ? AND status = 'pending'",
                [workerId],
              );
              if (slots <= (pending?.count ?? 0)) return null;
              return await assignUnassignedTaskPending(task.id, workerId, assignmentOptions);
            })
          : await assignUnassignedTaskPending(task.id, workerId, assignmentOptions);
      if (assignment) {
        assigned.push({ taskId: task.id, agentId: worker.id });
        reserved.set(worker.id, (reserved.get(worker.id) ?? 0) + 1);
        if (runtimeSlots.has(worker.id))
          runtimeSlots.set(worker.id, runtimeSlots.get(worker.id)! - 1);
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
