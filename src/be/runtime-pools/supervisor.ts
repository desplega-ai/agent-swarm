import { canProvisionKind, type RuntimeHandle } from "../../runtime-providers";
import {
  type ControllerCommands,
  ControllerOfflineError,
} from "../../runtime-providers/controller";
import { RuntimeHandleSchema } from "../../runtime-providers/controller-protocol";
import { RUNTIME_LABELS } from "../../runtime-providers/types";
import { resolveWorkerApiUrl } from "../../runtime-providers/worker-api-url";
import { createWorkerTaskFollowUp } from "../../tasks/worker-follow-up";
import {
  type Agent,
  isTerminalTaskStatus,
  type RuntimeInstance,
  type RuntimePool,
  TERMINAL_TASK_STATUSES,
} from "../../types";
import { isMultiRuntimeEnabled } from "../../utils/multi-runtime";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { registerVolatileSecret, scrubSecrets } from "../../utils/secret-scrubber";
import { workflowEventBus } from "../../workflows/event-bus";
import { canClaim } from "../budget-admission";
import { checkDependencies, failTask, getDbClient, getResolvedConfig, getTaskById } from "../db";
import {
  getRuntimeInstanceById,
  insertProvisioningRuntime,
  listRuntimeInstancesForAgent,
  listRuntimeInstancesForPool,
  markRuntimeTerminated,
  runtimeStaleThresholdMinutes,
} from "../multi-runtime";
import { mintRuntimeToken } from "../users";
import {
  clearRuntimeOwnerIdCache,
  ensureRuntimeOwnerId,
  getControllerCommands,
  reconcileDisconnectedControllers,
  reconcileRemoteProvisions,
} from "./controllers";
import {
  getPoolForAgent,
  getRuntimePool,
  listAgentsForPool,
  listRuntimePools,
  resolvePoolDelivery,
} from "./db";
import { type AgentDemand, computeDesired, pendingWorkForAgent } from "./demand";
import { resolveE2bImage, stopE2bImageBuilds } from "./e2b-images";
import { isRuntimeWanted, rotatingRuntimes } from "./lifecycle";
import {
  recoverPausedRuntime,
  recoverRuntime,
  serializeRuntimeAction,
  startRuntimeRecovery,
  stopRuntimeRecovery,
} from "./recovery";
import { remoteControllerSession } from "./remote-controller";

let timer: ReturnType<typeof setInterval> | null = null;
let kickTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let tickAbort: AbortController | null = null;
let warnedMultiRuntime = false;
const orphanFirstSeen = new Map<string, number>();
const ORPHAN_GRACE_MS = 120_000;
const TERMINAL_TASK_STATUS_PLACEHOLDERS = TERMINAL_TASK_STATUSES.map(() => "?").join(", ");
const TASKLESS_TRIGGER_SQL = "'unread_mentions', 'pool_tasks_available', 'channel_activity'";

export function runtimeSupervisorStatus(): string {
  if (!isRuntimePoolsEnabled()) return "disabled";
  if (!isMultiRuntimeEnabled()) return "disabled: MULTI_RUNTIME_ENABLED=false";
  return timer ? "running" : "stopped";
}

function reportSupervisorError(error: unknown): void {
  if (error instanceof ControllerOfflineError) return;
  console.error("[runtime-pools] Supervisor failed:", scrubSecrets(String(error)));
}

function runtimeNumber(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function poolLeaseTtl(pool: RuntimePool, controller: ControllerCommands): number {
  return Math.min(
    Math.max(pool.ttlSec ?? 900, runtimeNumber("RUNTIME_LEASE_RENEW_BEFORE_SEC", 300) + 60),
    controller.traits.maxTtlSec ?? Infinity,
    controller.traits.maxContinuousSec ?? Infinity,
  );
}

async function recordProvisionFailure(
  runtime: Pick<RuntimeInstance, "agentId" | "poolId" | "controllerId"> & { id: string | null },
  reason: string,
  now: Date,
  countedFailures: Set<string>,
): Promise<void> {
  const error = scrubSecrets(reason);
  const failedTask = await getDbClient().transaction(async (tx) => {
    if (runtime.id) {
      const retired = await tx.run(
        "UPDATE runtime_instances SET provision_error = ? WHERE id = ? AND status = 'provisioning' AND provision_error IS NULL",
        [error, runtime.id],
      );
      if (!retired.changes) return null;
      await markRuntimeTerminated(runtime.id, error);
    }
    // Retire every failed runtime, but advance retry and circuit state once per agent per tick.
    if (countedFailures.has(runtime.agentId)) return null;
    countedFailures.add(runtime.agentId);
    const pool = await tx.get<{ circuit_open_until: string | null }>(
      `UPDATE runtime_pools SET consecutive_failures = consecutive_failures + 1,
       last_error = ?, last_error_at = ?, updated_at = ?,
       circuit_open_until = CASE WHEN consecutive_failures + 1 >= ? OR circuit_open_until IS NOT NULL
         THEN ? ELSE circuit_open_until END WHERE id = ? RETURNING circuit_open_until`,
      [
        error,
        now.toISOString(),
        now.toISOString(),
        runtimeNumber("RUNTIME_CIRCUIT_THRESHOLD", 5),
        new Date(
          now.getTime() + runtimeNumber("RUNTIME_CIRCUIT_OPEN_MIN", 10) * 60_000,
        ).toISOString(),
        runtime.poolId ?? null,
      ],
    );
    await tx.run(
      "UPDATE runtime_controllers SET last_error = ?, last_error_at = ?, updated_at = ? WHERE id = ?",
      [error, now.toISOString(), now.toISOString(), runtime.controllerId ?? null],
    );
    const state = await tx.get<{ runtime_provision_attempts: number }>(
      "UPDATE agents SET runtime_provision_attempts = runtime_provision_attempts + 1 WHERE id = ? RETURNING runtime_provision_attempts",
      [runtime.agentId],
    );
    const attempts = state!.runtime_provision_attempts;
    const delay = [30, 90, 180][Math.min(attempts - 1, 2)]!;
    await tx.run("UPDATE agents SET runtime_provision_retry_at = ? WHERE id = ?", [
      new Date(now.getTime() + delay * 1000).toISOString(),
      runtime.agentId,
    ]);
    if (pool?.circuit_open_until)
      await tx.run(
        "UPDATE agents SET runtime_provision_attempts = 0, runtime_provision_retry_at = NULL WHERE runtime_pool_id = ?",
        [runtime.poolId ?? null],
      );
    if (attempts < runtimeNumber("RUNTIME_PROVISION_MAX_ATTEMPTS", 3)) return null;
    const pending = await tx.query<{ id: string }>(
      "SELECT id FROM agent_tasks WHERE agentId = ? AND status = 'pending' ORDER BY createdAt, rowid",
      [runtime.agentId],
    );
    for (const row of pending) {
      if (!(await checkDependencies(row.id)).ready) continue;
      const failed = await failTask(
        row.id,
        `provisioning failed after ${attempts} attempts: ${error}`,
      );
      if (!failed) continue;
      await tx.run(
        "UPDATE agents SET runtime_provision_attempts = 0, runtime_provision_retry_at = NULL WHERE id = ?",
        [runtime.agentId],
      );
      return failed;
    }
    await tx.run(
      "UPDATE agents SET runtime_provision_attempts = 0, runtime_provision_retry_at = NULL WHERE id = ?",
      [runtime.agentId],
    );
    return null;
  });
  if (failedTask) {
    try {
      await createWorkerTaskFollowUp({
        task: failedTask,
        status: "failed",
        failureReason: failedTask.failureReason ?? error,
      });
    } catch (followUpError) {
      reportSupervisorError(followUpError);
    }
  }
}

export async function provisionRuntime(
  pool: RuntimePool,
  agent: Agent,
  controller: ControllerCommands,
  ownerId: string,
  now = new Date(),
  options: {
    signal?: AbortSignal;
    onFailure?: () => void;
    countedFailures?: Set<string>;
  } = {},
): Promise<boolean> {
  const { signal, onFailure, countedFailures = new Set<string>() } = options;
  const runtimeId = crypto.randomUUID();
  try {
    const image =
      pool.kind === "e2b"
        ? await resolveE2bImage(pool.id, signal)
        : (pool.resolvedImage ?? pool.image!);
    if (signal?.aborted || image === null) return false;
    const token = await getDbClient().transaction(async () => {
      const credential = await mintRuntimeToken(agent.id, runtimeId);
      await insertProvisioningRuntime({
        id: runtimeId,
        agentId: agent.id,
        poolId: pool.id,
        controllerId: pool.placements[0]!,
        reportedSlots: pool.slotsPerRuntime,
      });
      await getDbClient().run(
        `UPDATE runtime_instances SET provision_attempts =
           (SELECT runtime_provision_attempts + 1 FROM agents WHERE id = ?),
         provision_requested_at = ? WHERE id = ?`,
        [agent.id, now.toISOString(), runtimeId],
      );
      signal?.throwIfAborted();
      return credential.plaintext;
    });
    signal?.throwIfAborted();
    registerVolatileSecret(token, `runtime:${runtimeId}`);
    const templateId = (await getResolvedConfig(agent.id)).find(
      (c) => c.key === "TEMPLATE_ID",
    )?.value;
    signal?.throwIfAborted();
    const env: Record<string, string> = {
      ...pool.env,
      MCP_BASE_URL: resolveWorkerApiUrl({
        WORKER_API_URL: controller.workerApiUrl,
        RUNTIME_WORKER_API_URL: process.env.RUNTIME_WORKER_API_URL,
      }),
      AGENT_ID: agent.id,
      AGENT_ROLE: agent.isLead ? "lead" : "worker",
      HARNESS_PROVIDER: agent.harnessProvider ?? "claude",
      API_KEY: token,
      AGENT_SWARM_API_KEY: token,
      SWARM_RUNTIME_INSTANCE_ID: runtimeId,
      MAX_CONCURRENT_TASKS: String(pool.slotsPerRuntime),
      SWARM_DELIVERY_MODE: resolvePoolDelivery(pool),
    };
    // Lifecycle and template identity belong to the API, even when absent.
    delete env.SWARM_EXIT_AFTER_TASKS;
    delete env.TEMPLATE_ID;
    if (pool.lifecycle === "per-task") env.SWARM_EXIT_AFTER_TASKS = "1";
    if (templateId) env.TEMPLATE_ID = templateId;
    const ttlSec = pool.kind === "e2b" ? poolLeaseTtl(pool, controller) : undefined;
    signal?.throwIfAborted();
    const handle = await controller.provision({
      runtimeId,
      agentId: agent.id,
      poolId: pool.id,
      ownerId,
      image,
      ...(ttlSec === undefined ? {} : { ttlSec }),
      env,
      resources: pool.resources ?? undefined,
      labels: {
        [RUNTIME_LABELS.runtimeId]: runtimeId,
        [RUNTIME_LABELS.poolId]: pool.id,
        [RUNTIME_LABELS.agentId]: agent.id,
        [RUNTIME_LABELS.owner]: ownerId,
      },
    });
    if (signal?.aborted) {
      await controller.terminate(handle, "Supervisor stopped during provision");
      await markRuntimeTerminated(runtimeId, "Supervisor stopped during provision");
      return false;
    }
    await getDbClient().run(
      "UPDATE runtime_instances SET external_handle = ?, lease_expires_at = ?, created_at = COALESCE(?, created_at), updated_at = ? WHERE id = ?",
      [
        JSON.stringify(handle),
        ttlSec === undefined
          ? null
          : (handle.meta?.leaseExpiresAt ?? new Date(now.getTime() + ttlSec * 1000).toISOString()),
        pool.kind === "e2b" ? (handle.createdAt ?? now.toISOString()) : null,
        new Date().toISOString(),
        runtimeId,
      ],
    );
    return true;
  } catch (error) {
    // Stop new requests before asynchronous failure cleanup commits.
    onFailure?.();
    if (signal?.aborted) {
      await markRuntimeTerminated(runtimeId, "Supervisor stopped during provision");
      return false;
    }
    reportSupervisorError(error);
    // Keep an ambiguous remote provision reserved until reconnect or disconnect recovery.
    if (error instanceof ControllerOfflineError) return false;
    try {
      const runtime = await getRuntimeInstanceById(runtimeId);
      await recordProvisionFailure(
        runtime ?? {
          id: null,
          agentId: agent.id,
          poolId: pool.id,
          controllerId: pool.placements[0]!,
        },
        String(error),
        now,
        countedFailures,
      );
    } catch (cleanupError) {
      reportSupervisorError(cleanupError);
    }
    return false;
  }
}

export function runtimeHandle(runtime: RuntimeInstance): RuntimeHandle | null {
  return runtime.externalHandle ? RuntimeHandleSchema.parse(runtime.externalHandle) : null;
}

export async function terminateRuntime(
  runtime: RuntimeInstance,
  controller: ControllerCommands,
  reason: string,
): Promise<void> {
  const handle = runtimeHandle(runtime);
  try {
    if (handle) await controller.terminate(handle, reason);
  } catch (error) {
    reportSupervisorError(error);
  }
  await markRuntimeTerminated(runtime.id, reason);
}

export async function reapPoolRuntimes(
  pool: RuntimePool,
  runtimes: RuntimeInstance[],
  controller: ControllerCommands,
  now: Date,
  listedHandles?: RuntimeHandle[] | null,
  rotatingIds?: ReadonlySet<string>,
  countedFailures = new Set<string>(),
  controllers: ReadonlyMap<string, ControllerCommands> = new Map([
    [pool.placements[0]!, controller],
  ]),
  listings: ReadonlyMap<string, RuntimeHandle[] | null | undefined> = new Map([
    [pool.placements[0]!, listedHandles],
  ]),
): Promise<void> {
  const rotations =
    rotatingIds ??
    (await rotatingRuntimes(
      pool.id,
      new Date(
        now.getTime() + runtimeNumber("RUNTIME_TOKEN_ROTATE_BEFORE_MIN", 60) * 60_000,
      ).toISOString(),
      now,
      controller.traits.maxContinuousSec,
    ));
  const cutoff = now.getTime() - runtimeStaleThresholdMinutes() * 60_000;
  const sessionCutoff = new Date(
    now.getTime() - runtimeNumber("HEARTBEAT_STALE_CLEANUP_MIN", 30) * 60_000,
  ).toISOString();
  const remaining = new Map<string, number>();
  const statusesByController = new Map<string, Awaited<ReturnType<ControllerCommands["status"]>>>();
  for (const [controllerId, controller] of controllers) {
    const handles = runtimes
      .filter(
        (r) =>
          (r.controllerId ?? pool.placements[0]) === controllerId &&
          r.status !== "offline" &&
          (runtimeHandle(r)?.kind === "e2b" || Date.parse(r.lastSeenAt) >= cutoff),
      )
      .map(runtimeHandle)
      .filter((h): h is RuntimeHandle => h !== null);
    let statuses: Awaited<ReturnType<ControllerCommands["status"]>> = {};
    try {
      if (handles.length) statuses = await controller.status(handles);
    } catch (error) {
      reportSupervisorError(error);
      // One lookup failure must not prevent sibling recovery.
      for (const handle of handles) {
        try {
          Object.assign(statuses, await controller.status([handle]));
        } catch (lookupError) {
          reportSupervisorError(lookupError);
        }
      }
    }
    statusesByController.set(controllerId, statuses);
  }
  for (const runtime of runtimes)
    if (
      runtime.status === "provisioning" ||
      (runtime.status === "active" &&
        (Date.parse(runtime.lastSeenAt) >= cutoff ||
          (runtimeHandle(runtime)?.kind === "e2b" &&
            statusesByController.get(runtime.controllerId ?? pool.placements[0]!)?.[
              runtimeHandle(runtime)?.externalId ?? ""
            ] === "paused")))
    )
      remaining.set(runtime.agentId, (remaining.get(runtime.agentId) ?? 0) + 1);
  for (const candidate of runtimes) {
    try {
      await serializeRuntimeAction(candidate.id, async () => {
        const runtime = await getRuntimeInstanceById(candidate.id);
        if (!runtime) return;
        const staleSession =
          pool.lifecycle === "per-task" && runtime.status !== "offline"
            ? null
            : await getDbClient().get<{ id: string }>(
                `SELECT id FROM active_sessions WHERE runtimeInstanceId = ? AND NOT EXISTS (
            SELECT 1 FROM agent_tasks WHERE id = active_sessions.taskId
              AND status NOT IN (${TERMINAL_TASK_STATUS_PLACEHOLDERS})
          ) AND (EXISTS (SELECT 1 FROM agent_tasks WHERE id = active_sessions.taskId)
            OR triggerType NOT IN (${TASKLESS_TRIGGER_SQL}) OR lastHeartbeatAt < ?) LIMIT 1`,
                [runtime.id, ...TERMINAL_TASK_STATUSES, sessionCutoff],
              );
        if (staleSession)
          await getDbClient().run(
            `DELETE FROM active_sessions WHERE runtimeInstanceId = ? AND NOT EXISTS (
              SELECT 1 FROM agent_tasks WHERE id = active_sessions.taskId
                AND status NOT IN (${TERMINAL_TASK_STATUS_PLACEHOLDERS})
            ) AND (EXISTS (SELECT 1 FROM agent_tasks WHERE id = active_sessions.taskId)
              OR triggerType NOT IN (${TASKLESS_TRIGGER_SQL}) OR lastHeartbeatAt < ?)`,
            [runtime.id, ...TERMINAL_TASK_STATUSES, sessionCutoff],
          );
        if (runtime.status === "offline") {
          const session = await getDbClient().get<{ taskId: string }>(
            "SELECT taskId FROM active_sessions WHERE runtimeInstanceId = ? LIMIT 1",
            [runtime.id],
          );
          if (session)
            await recoverRuntime(runtime.id, runtime.provisionError ?? "Runtime offline");
          return;
        }
        const controllerId = runtime.controllerId ?? pool.placements[0]!;
        const controller = controllers.get(controllerId);
        if (!controller) return;
        const listedHandles = listings.get(controllerId);
        const handle = runtimeHandle(runtime);
        let status = handle
          ? statusesByController.get(controllerId)?.[handle.externalId]
          : undefined;
        const isE2b = handle?.kind === "e2b";
        if (isE2b && status === "paused" && handle)
          status = (await controller.status([handle]))[handle.externalId];
        const stale =
          runtime.status === "active" &&
          Date.parse(runtime.lastSeenAt) < cutoff &&
          !(isE2b && status === "paused");
        const missing =
          handle &&
          listedHandles &&
          !listedHandles.some((h) => h.externalId === handle.externalId) &&
          !(isE2b && status === "paused");
        const timeoutSec = runtimeNumber("RUNTIME_PROVISION_TIMEOUT_SEC", 300);
        const timedOut =
          runtime.status === "provisioning" &&
          now.getTime() - Date.parse(runtime.provisionRequestedAt ?? runtime.createdAt) >=
            timeoutSec * 1000;
        if (status === "exited" || status === "failed" || stale || missing || timedOut) {
          const reason = timedOut
            ? `runtime did not register within ${timeoutSec}s (image may lack the swarm runner, or WORKER_API_URL is unreachable)`
            : stale
              ? "Runtime stopped pinging"
              : missing
                ? "Runtime missing from provider list"
                : `Runtime ${status}`;
          if (runtime.status === "provisioning") {
            await recordProvisionFailure(runtime, reason, now, countedFailures);
            if ((await getRuntimeInstanceById(runtime.id))?.status !== "offline") return;
          }
          await terminateRuntime(runtime, controller, reason);
          await recoverRuntime(runtime.id, reason);
          if (!stale) remaining.set(runtime.agentId, (remaining.get(runtime.agentId) ?? 1) - 1);
          return;
        }
        const busy = await getDbClient().get<{ taskId: string }>(
          `SELECT s.taskId FROM active_sessions s LEFT JOIN agent_tasks t ON t.id = s.taskId
           WHERE s.runtimeInstanceId = ? AND (t.status NOT IN (${TERMINAL_TASK_STATUS_PLACEHOLDERS})
             OR (t.id IS NULL AND s.triggerType IN (${TASKLESS_TRIGGER_SQL}) AND s.lastHeartbeatAt >= ?)) LIMIT 1`,
          [runtime.id, ...TERMINAL_TASK_STATUSES, sessionCutoff],
        );
        const task = runtime.taskId ? await getTaskById(runtime.taskId) : null;
        const taskRunning = task?.status === "in_progress" || task?.status === "reviewing";
        const rotating = rotations.has(runtime.id);
        if (status === "paused" && isE2b) {
          await recoverPausedRuntime(
            runtime,
            controller,
            await isRuntimeWanted(
              pool,
              runtime,
              rotating,
              remaining.get(runtime.agentId) ?? 0,
              now,
            ),
            !!busy || taskRunning,
            now,
          );
          if ((await getRuntimeInstanceById(runtime.id))?.status === "offline")
            remaining.set(runtime.agentId, (remaining.get(runtime.agentId) ?? 1) - 1);
          return;
        }
        if (runtime.status !== "active" && pool.enabled) return;
        if (busy || taskRunning) {
          await getDbClient().run(
            "UPDATE runtime_instances SET idle_since = NULL, draining = ?, task_id = COALESCE((SELECT id FROM agent_tasks WHERE id = ?), task_id) WHERE id = ?",
            [rotating || !pool.enabled ? 1 : 0, busy?.taskId ?? null, runtime.id],
          );
          return;
        }
        if (pool.lifecycle === "per-task" && task && isTerminalTaskStatus(task.status)) {
          const finishedAt = task.finishedAt ?? runtime.idleSince ?? now.toISOString();
          if (!runtime.idleSince)
            await getDbClient().run("UPDATE runtime_instances SET idle_since = ? WHERE id = ?", [
              finishedAt,
              runtime.id,
            ]);
          if (
            now.getTime() - Date.parse(finishedAt) <
            runtimeNumber("RUNTIME_PER_TASK_EXIT_GRACE_SEC", 60) * 1000
          )
            return;
          await terminateRuntime(runtime, controller, "Task exit grace expired");
          remaining.set(runtime.agentId, (remaining.get(runtime.agentId) ?? 1) - 1);
          return;
        }
        if (rotating) {
          if (!runtime.draining) {
            await getDbClient().run("UPDATE runtime_instances SET draining = 1 WHERE id = ?", [
              runtime.id,
            ]);
          } else {
            await terminateRuntime(
              runtime,
              controller,
              controller.traits.maxContinuousSec === undefined
                ? "Runtime token expires soon"
                : "Runtime rotation due",
            );
            remaining.set(runtime.agentId, (remaining.get(runtime.agentId) ?? 1) - 1);
          }
          return;
        }
        if (!pool.enabled) {
          if (!runtime.draining) {
            await getDbClient().run("UPDATE runtime_instances SET draining = 1 WHERE id = ?", [
              runtime.id,
            ]);
          } else {
            await terminateRuntime(runtime, controller, "Pool disabled");
            remaining.set(runtime.agentId, (remaining.get(runtime.agentId) ?? 1) - 1);
          }
          return;
        }
        const idleSince = runtime.idleSince ?? now.toISOString();
        if (!runtime.idleSince)
          await getDbClient().run("UPDATE runtime_instances SET idle_since = ? WHERE id = ?", [
            idleSince,
            runtime.id,
          ]);
        if (pool.lifecycle !== "idle" || pool.idleMinutes === null) return;
        if ((remaining.get(runtime.agentId) ?? 0) <= pool.minRuntimes) {
          if (runtime.draining)
            await getDbClient().run("UPDATE runtime_instances SET draining = 0 WHERE id = ?", [
              runtime.id,
            ]);
          return;
        }
        if (now.getTime() - Date.parse(idleSince) < pool.idleMinutes * 60_000) return;
        if (!runtime.draining) {
          await getDbClient().run("UPDATE runtime_instances SET draining = 1 WHERE id = ?", [
            runtime.id,
          ]);
        } else {
          await terminateRuntime(runtime, controller, "Idle timeout");
          remaining.set(runtime.agentId, (remaining.get(runtime.agentId) ?? 1) - 1);
        }
      });
    } catch (error) {
      reportSupervisorError(error);
    }
  }
}

async function renewPoolLeases(
  pool: RuntimePool,
  controllers: ReadonlyMap<string, ControllerCommands>,
  now: Date,
): Promise<void> {
  for (const runtime of await listRuntimeInstancesForPool(pool.id)) {
    const controller = controllers.get(runtime.controllerId ?? pool.placements[0]!);
    const handle = runtimeHandle(runtime);
    if (handle?.kind !== "e2b" || !controller?.renew) continue;
    const renewBy =
      now.getTime() +
      Math.min(
        runtimeNumber("RUNTIME_LEASE_RENEW_BEFORE_SEC", 300),
        poolLeaseTtl(pool, controller) - Math.min(60, poolLeaseTtl(pool, controller) / 2),
      ) *
        1000;
    if (
      runtime.status === "offline" ||
      (runtime.leaseExpiresAt && Date.parse(runtime.leaseExpiresAt) > renewBy)
    )
      continue;
    try {
      const { endAt } = await controller.renew(handle, poolLeaseTtl(pool, controller));
      if (!Number.isFinite(Date.parse(endAt)))
        throw new Error("Provider returned an invalid lease expiry");
      await getDbClient().run(
        "UPDATE runtime_instances SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status != 'offline'",
        [endAt, now.toISOString(), runtime.id],
      );
      console.debug(
        scrubSecrets(`[runtime-pools] Runtime ${runtime.id} lease renewed until ${endAt}`),
      );
    } catch (error) {
      reportSupervisorError(error);
      // The next full reap checks provider death and preserves pool lifecycle rules.
    }
  }
}

export async function reconcileControllerOrphans(
  controllerId: string,
  controller: ControllerCommands,
  ownerId: string,
  now = new Date(),
  listedHandles?: RuntimeHandle[] | null,
): Promise<void> {
  const rows = await getDbClient().query<{
    id: string;
    status: string;
    external_handle: string | null;
  }>("SELECT id, status, external_handle FROM runtime_instances WHERE controller_id = ?", [
    controllerId,
  ]);
  const known = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!row.external_handle) continue;
    try {
      known.set(RuntimeHandleSchema.parse(JSON.parse(row.external_handle)).externalId, row);
    } catch (error) {
      reportSupervisorError(error);
    }
  }
  const handles = listedHandles ?? (await controller.list(ownerId));
  const listed = new Set(handles.map((handle) => `${controllerId}:${handle.externalId}`));
  for (const key of orphanFirstSeen.keys())
    if (key.startsWith(`${controllerId}:`) && !listed.has(key)) orphanFirstSeen.delete(key);
  for (const handle of handles) {
    try {
      const row = known.get(handle.externalId);
      const key = `${controllerId}:${handle.externalId}`;
      if (row && row.status !== "offline") {
        orphanFirstSeen.delete(key);
        continue;
      }
      if (!row) {
        const created = handle.createdAt ? Date.parse(handle.createdAt) : NaN;
        const firstSeen = Number.isFinite(created)
          ? created
          : (orphanFirstSeen.get(key) ?? now.getTime());
        orphanFirstSeen.set(key, firstSeen);
        if (now.getTime() - firstSeen < ORPHAN_GRACE_MS) continue;
      }
      await controller.terminate(handle, "Orphan runtime");
      if (row) await markRuntimeTerminated(row.id, "Runtime closed");
      orphanFirstSeen.delete(key);
    } catch (error) {
      reportSupervisorError(error);
    }
  }
}

async function reconcilePools(
  now: Date,
  commands: typeof getControllerCommands,
  signal: AbortSignal,
): Promise<void> {
  await reconcileDisconnectedControllers(recoverRuntime, now);
  const ownerId = await ensureRuntimeOwnerId();
  const controllers = new Map<string, ControllerCommands>();
  const listed = new Map<string, RuntimeHandle[] | null>();
  const countedFailures = new Set<string>();
  const rotationCutoff = new Date(
    now.getTime() + runtimeNumber("RUNTIME_TOKEN_ROTATE_BEFORE_MIN", 60) * 60_000,
  ).toISOString();
  for (const pool of await listRuntimePools()) {
    if (signal.aborted) return;
    if (!canProvisionKind(pool.kind)) continue;
    const controllerId = pool.placements[0]!;
    try {
      const poolRuntimes = await listRuntimeInstancesForPool(pool.id);
      const poolControllerIds = new Set([
        controllerId,
        ...poolRuntimes.map((r) => r.controllerId ?? controllerId),
      ]);
      const rotatingIds = new Set<string>();
      for (const id of poolControllerIds) {
        try {
          const controller = controllers.get(id) ?? (await commands(id));
          controllers.set(id, controller);
          if (!controller.traits.canProvision) continue;
          if (!listed.has(id)) {
            try {
              listed.set(id, await controller.list(ownerId));
            } catch (error) {
              reportSupervisorError(error);
              listed.set(id, null);
            }
            const handles = listed.get(id);
            if (handles && remoteControllerSession(id) === controller)
              await reconcileRemoteProvisions(id, handles, ownerId);
            if (handles) await reconcileControllerOrphans(id, controller, ownerId, now, handles);
          }
          const rotations = await rotatingRuntimes(
            pool.id,
            rotationCutoff,
            now,
            controller.traits.maxContinuousSec,
          );
          for (const runtime of poolRuntimes)
            if ((runtime.controllerId ?? controllerId) === id && rotations.has(runtime.id))
              rotatingIds.add(runtime.id);
        } catch (error) {
          reportSupervisorError(error);
        }
      }
      const controller = controllers.get(controllerId);
      const existingController =
        controller ??
        [...poolControllerIds].map((id) => controllers.get(id)).find((c) => c?.traits.canProvision);
      if (!existingController) continue;
      await reapPoolRuntimes(
        pool,
        await listRuntimeInstancesForPool(pool.id),
        existingController,
        now,
        listed.get(controllerId),
        rotatingIds,
        countedFailures,
        controllers,
        listed,
      );
      await renewPoolLeases(pool, controllers, now);
      if (signal.aborted) return;
      if (!controller?.traits.canProvision) continue;
      const currentPool = await getRuntimePool(pool.id);
      const agents = await listAgentsForPool(pool.id);
      const demands: AgentDemand[] = [];
      const work = new Map<string, Awaited<ReturnType<typeof pendingWorkForAgent>>>();
      for (const agent of agents) {
        if (signal.aborted) return;
        const pending = await pendingWorkForAgent(agent.id);
        work.set(agent.id, pending);
        if (!pending.work && (agent.runtimeProvisionAttempts || agent.runtimeProvisionRetryAt))
          await getDbClient().run(
            "UPDATE agents SET runtime_provision_attempts = 0, runtime_provision_retry_at = NULL WHERE id = ?",
            [agent.id],
          );
        const runtimes = await listRuntimeInstancesForAgent(agent.id);
        let freeSlots = 0;
        let provisioning = 0;
        for (const runtime of runtimes) {
          if (runtime.status === "provisioning") provisioning++;
          if (!runtime.isLive || runtime.draining || runtime.credentialReady === false) continue;
          const task = runtime.taskId ? await getTaskById(runtime.taskId) : null;
          if (pool.lifecycle === "per-task" && task && isTerminalTaskStatus(task.status)) continue;
          const sessions = await getDbClient().get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM active_sessions WHERE runtimeInstanceId = ?",
            [runtime.id],
          );
          let occupied = sessions?.count ?? 0;
          if (occupied === 0 && runtime.taskId) {
            if (task?.status === "in_progress" || task?.status === "reviewing") occupied = 1;
          }
          freeSlots += Math.max(0, runtime.reportedSlots - occupied);
        }
        demands.push({
          agentId: agent.id,
          maxTasks: agent.maxTasks ?? 1,
          work: pending.work,
          current: runtimes.filter(
            (r) =>
              r.status === "provisioning" || (r.isLive && !(r.draining && rotatingIds.has(r.id))),
          ).length,
          freeSlots,
          provisioning,
        });
      }
      if (
        !pool.enabled ||
        (currentPool?.circuitOpenUntil && Date.parse(currentPool.circuitOpenUntil) > now.getTime())
      )
        continue;
      const poolCount = (await listRuntimeInstancesForPool(pool.id)).filter(
        (r) =>
          r.status === "provisioning" ||
          (r.status === "active" &&
            Date.parse(r.lastSeenAt) >= now.getTime() - runtimeStaleThresholdMinutes() * 60_000),
      ).length;
      const counted = demands.reduce((n, d) => n + d.current, 0);
      const desired = computeDesired(
        {
          ...pool,
          maxRuntimes:
            pool.maxRuntimes === null
              ? null
              : Math.max(0, pool.maxRuntimes - Math.max(0, poolCount - counted)),
        },
        demands,
      );
      const provisions = new Set<Promise<void>>();
      const failedAgents = new Set<string>();
      const concurrency = runtimeNumber("RUNTIME_PROVISION_CONCURRENCY", 8);
      try {
        for (const agent of agents) {
          const demand = demands.find((d) => d.agentId === agent.id)!;
          const pending = work.get(agent.id)!;
          for (let count = demand.current; count < (desired.get(agent.id) ?? 0); count++) {
            if (provisions.size >= concurrency) await Promise.race(provisions);
            if (signal.aborted) return;
            if (failedAgents.has(agent.id)) break;
            if (!(pool.resolvedImage ?? pool.image)) break;
            if (!(await canClaim(agent.id, now, pending.topTask?.requestedByUserId)).allowed) break;
            if (signal.aborted) return;
            const retry = await getDbClient().get<{
              runtime_provision_retry_at: string | null;
              runtime_provision_attempts: number;
            }>(
              "SELECT runtime_provision_retry_at, runtime_provision_attempts FROM agents WHERE id = ?",
              [agent.id],
            );
            if (
              retry?.runtime_provision_retry_at &&
              Date.parse(retry.runtime_provision_retry_at) > now.getTime()
            )
              break;
            const retrying = (retry?.runtime_provision_attempts ?? 0) > 0;
            if (retrying && demand.provisioning > 0) break;
            const freshPool = await getRuntimePool(pool.id);
            if (!freshPool?.enabled) break;
            if (freshPool.circuitOpenUntil) {
              if (Date.parse(freshPool.circuitOpenUntil) > now.getTime()) break;
              if (
                provisions.size ||
                (await listRuntimeInstancesForPool(pool.id)).some(
                  (r) => r.status === "provisioning",
                )
              )
                break;
            }
            if (signal.aborted) return;
            if (failedAgents.has(agent.id)) break;
            const provision = provisionRuntime(pool, agent, controller, ownerId, now, {
              signal,
              countedFailures,
              onFailure: () => {
                failedAgents.add(agent.id);
              },
            }).then(
              (success) => {
                provisions.delete(provision);
                if (!success) failedAgents.add(agent.id);
              },
              (error) => {
                provisions.delete(provision);
                failedAgents.add(agent.id);
                reportSupervisorError(error);
              },
            );
            provisions.add(provision);
            if (retrying) break;
          }
        }
      } finally {
        await Promise.all(provisions);
      }
    } catch (error) {
      reportSupervisorError(error);
    }
  }
}

export async function reconcileOnce(
  opts: { now?: Date; getControllerCommands?: typeof getControllerCommands } = {},
): Promise<void> {
  if (!isRuntimePoolsEnabled() || !isMultiRuntimeEnabled() || inFlight) return;
  tickAbort = new AbortController();
  inFlight = reconcilePools(
    opts.now ?? new Date(),
    opts.getControllerCommands ?? getControllerCommands,
    tickAbort.signal,
  );
  try {
    await inFlight;
  } catch (error) {
    reportSupervisorError(error);
  } finally {
    inFlight = null;
    tickAbort = null;
  }
}

const onTaskCreated = (data: unknown): void => {
  const taskId = (data as { taskId?: unknown } | null)?.taskId;
  if (typeof taskId !== "string" || !timer || !isRuntimePoolsEnabled() || !isMultiRuntimeEnabled())
    return;
  void (async () => {
    const task = await getTaskById(taskId);
    const agentId =
      task?.status === "offered"
        ? task.offeredTo
        : task?.status === "pending"
          ? task.agentId
          : null;
    if (!agentId || !(await getPoolForAgent(agentId)) || !timer) return;
    if (kickTimer) clearTimeout(kickTimer);
    kickTimer = setTimeout(() => {
      kickTimer = null;
      void reconcileOnce().catch(reportSupervisorError);
    }, 250);
    kickTimer.unref?.();
  })().catch(reportSupervisorError);
};

export function startRuntimeSupervisor(
  intervalMs = Number(process.env.RUNTIME_SUPERVISOR_INTERVAL_MS) || 5000,
): void {
  if (timer || !isRuntimePoolsEnabled()) return;
  if (!isMultiRuntimeEnabled()) {
    if (!warnedMultiRuntime) {
      console.error("[runtime-pools] Supervisor requires MULTI_RUNTIME_ENABLED=true.");
      warnedMultiRuntime = true;
    }
    return;
  }
  workflowEventBus.on("task.created", onTaskCreated);
  startRuntimeRecovery();
  timer = setInterval(
    () => {
      void reconcileOnce().catch(reportSupervisorError);
    },
    Math.max(1, intervalMs),
  );
  timer.unref?.();
}

export async function stopRuntimeSupervisor(timeoutMs = 10_000): Promise<void> {
  if (timer) clearInterval(timer);
  if (kickTimer) clearTimeout(kickTimer);
  timer = null;
  kickTimer = null;
  workflowEventBus.off("task.created", onTaskCreated);
  stopRuntimeRecovery();
  tickAbort?.abort();
  stopE2bImageBuilds();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (inFlight) {
      await Promise.race([
        inFlight.catch(reportSupervisorError),
        new Promise<void>((resolve) => {
          timeout = setTimeout(
            () => {
              console.error("[runtime-pools] Supervisor shutdown timed out.");
              resolve();
            },
            Math.min(10_000, Math.max(0, timeoutMs)),
          );
        }),
      ]);
    }
  } catch (error) {
    reportSupervisorError(error);
  } finally {
    if (timeout) clearTimeout(timeout);
    clearRuntimeOwnerIdCache();
    orphanFirstSeen.clear();
  }
}
