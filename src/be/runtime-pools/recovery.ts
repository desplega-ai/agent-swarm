import { AsyncLocalStorage } from "node:async_hooks";
import { realtimeBus } from "../../realtime/bus";
import { canProvisionKind } from "../../runtime-providers";
import type { ControllerCommands } from "../../runtime-providers/controller";
import type { RuntimeInstance } from "../../types";
import { isMultiRuntimeEnabled } from "../../utils/multi-runtime";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient, getTaskById } from "../db";
import {
  getRuntimeInstanceById,
  listRuntimeInstancesForPool,
  markRuntimeTerminated,
  runtimeStaleThresholdMinutes,
} from "../multi-runtime";
import { ensureRuntimeOwnerId, getControllerCommands } from "./controllers";
import { getRuntimePool, resolvePoolDelivery } from "./db";
import { isRuntimeWanted, rotatingRuntimes } from "./lifecycle";
import { runtimeHandle, terminateRuntime } from "./supervisor";

const recovering = new Map<string, Promise<void>>();
const currentAction = new AsyncLocalStorage<string>();
const socketChecks = new Map<string, ReturnType<typeof setTimeout>>();
const sockets = new Map<string, number>();
let subscriptions: Array<() => void> = [];

function reportRecoveryError(error: unknown): void {
  console.error("[runtime-pools] Recovery failed:", scrubSecrets(String(error)));
}

export async function serializeRuntimeAction(
  runtimeId: string,
  action: () => Promise<void>,
): Promise<void> {
  if (currentAction.getStore() === runtimeId) return action();
  const previous = recovering.get(runtimeId) ?? Promise.resolve();
  const recovery = previous
    .catch(reportRecoveryError)
    .then(() => currentAction.run(runtimeId, action));
  recovering.set(runtimeId, recovery);
  try {
    await recovery;
  } finally {
    if (recovering.get(runtimeId) === recovery) recovering.delete(runtimeId);
  }
}

async function recoverSessions(runtimeId: string, reason: string): Promise<void> {
  const sessions = await getDbClient().query<{ taskId: string }>(
    "SELECT taskId FROM active_sessions WHERE runtimeInstanceId = ?",
    [runtimeId],
  );
  if (isRuntimePoolsEnabled()) {
    const dispatched = await getDbClient().query<{ taskId: string }>(
      `SELECT t.id AS taskId FROM agent_tasks t
       WHERE (t.runtime_instance_id = ? OR t.id IN (
         SELECT task_id FROM runtime_instances WHERE id = ? AND agent_id = t.agentId
       )) AND t.status = 'in_progress'
       AND NOT EXISTS (SELECT 1 FROM active_sessions s WHERE s.taskId = t.id)`,
      [runtimeId, runtimeId],
    );
    sessions.push(...dispatched);
  }
  if (!sessions.length) return;
  const { remediateTaskForDeadRuntime } = await import("../../heartbeat/heartbeat");
  for (const session of sessions) {
    try {
      const task = await getTaskById(session.taskId);
      if (task?.status === "in_progress") await remediateTaskForDeadRuntime(task, reason);
      else
        await getDbClient().run(
          "DELETE FROM active_sessions WHERE taskId = ? AND runtimeInstanceId = ?",
          [session.taskId, runtimeId],
        );
    } catch (error) {
      reportRecoveryError(error);
    }
  }
}

export async function recoverRuntime(runtimeId: string, reason: string): Promise<void> {
  await serializeRuntimeAction(runtimeId, async () => {
    await markRuntimeTerminated(runtimeId, scrubSecrets(reason));
    await recoverSessions(runtimeId, reason);
  });
}

export async function recoverPausedRuntime(
  runtime: RuntimeInstance,
  controller: ControllerCommands,
  wanted: boolean,
  busy: boolean,
  now = new Date(),
): Promise<void> {
  if (busy) {
    await terminateRuntime(runtime, controller, "Runtime paused during a task");
    await recoverRuntime(runtime.id, "Runtime paused during a task");
  } else if (!wanted) {
    await terminateRuntime(runtime, controller, "Paused runtime no longer wanted");
  } else {
    const handle = runtimeHandle(runtime);
    if (!handle || !controller.resume) throw new Error("Controller cannot resume a paused runtime");
    await controller.resume(handle);
    await getDbClient().run(
      "UPDATE runtime_instances SET last_seen_at = ?, lease_expires_at = NULL WHERE id = ? AND status != 'offline'",
      [now.toISOString(), runtime.id],
    );
  }
}

export async function remediateStalledRuntime(
  runtimeId: string,
  reason: string,
  remediate: (fence: () => Promise<void>) => Promise<boolean>,
): Promise<boolean> {
  if (!isRuntimePoolsEnabled() || !isMultiRuntimeEnabled()) return false;
  const runtime = await getRuntimeInstanceById(runtimeId);
  const pool = runtime?.poolId ? await getRuntimePool(runtime.poolId) : null;
  if (!runtime || !pool || !canProvisionKind(pool.kind)) return false;
  await serializeRuntimeAction(runtimeId, async () => {
    if (await remediate(() => fenceStalledRuntime(runtime, reason)))
      await recoverSessions(runtimeId, reason);
  });
  return true;
}

async function fenceStalledRuntime(runtime: RuntimeInstance, reason: string): Promise<void> {
  await markRuntimeTerminated(runtime.id, scrubSecrets(reason));
  try {
    if (runtime.controllerId)
      await terminateRuntime(runtime, await getControllerCommands(runtime.controllerId), reason);
  } catch (error) {
    reportRecoveryError(error);
  }
}

export async function checkDisconnectedRuntime(runtimeId: string): Promise<void> {
  if (!isRuntimePoolsEnabled() || !isMultiRuntimeEnabled()) return;
  await serializeRuntimeAction(runtimeId, async () => {
    const runtime = await getRuntimeInstanceById(runtimeId);
    if (!runtime || runtime.status !== "active" || !runtime.poolId || !runtime.controllerId) return;
    const pool = await getRuntimePool(runtime.poolId);
    if (!pool || !canProvisionKind(pool.kind) || resolvePoolDelivery(pool) !== "push") return;
    const handle = runtimeHandle(runtime);
    if (!handle) return;
    const controller = await getControllerCommands(runtime.controllerId);
    const status = (await controller.status([handle]))[handle.externalId];
    if (status === "paused" && pool.kind === "e2b") {
      const session = await getDbClient().get(
        "SELECT taskId FROM active_sessions WHERE runtimeInstanceId = ? LIMIT 1",
        [runtimeId],
      );
      const task = runtime.taskId ? await getTaskById(runtime.taskId) : null;
      const now = new Date();
      const configured = Number(process.env.RUNTIME_TOKEN_ROTATE_BEFORE_MIN);
      const beforeMin = Number.isInteger(configured) && configured > 0 ? configured : 60;
      const rotations = await rotatingRuntimes(
        pool.id,
        new Date(now.getTime() + beforeMin * 60_000).toISOString(),
        now,
        controller.traits.maxContinuousSec,
      );
      const siblings = (await listRuntimeInstancesForPool(pool.id)).filter(
        (r) => r.agentId === runtime.agentId,
      );
      const cutoff = now.getTime() - runtimeStaleThresholdMinutes() * 60_000;
      const staleHandles = siblings
        .filter(
          (r) => r.id !== runtimeId && r.status === "active" && Date.parse(r.lastSeenAt) < cutoff,
        )
        .map(runtimeHandle)
        .filter((h) => h !== null);
      const statuses = staleHandles.length ? await controller.status(staleHandles) : {};
      const remaining = siblings.filter(
        (r) =>
          r.status === "provisioning" ||
          (r.status === "active" &&
            (Date.parse(r.lastSeenAt) >= cutoff ||
              r.id === runtimeId ||
              statuses[runtimeHandle(r)?.externalId ?? ""] === "paused")),
      ).length;
      await recoverPausedRuntime(
        runtime,
        controller,
        await isRuntimeWanted(pool, runtime, rotations.has(runtime.id), remaining, now),
        !!session || task?.status === "in_progress" || task?.status === "reviewing",
      );
      return;
    }
    if (status === "running" || status === "starting" || status === "paused") return;
    if (
      status === "exited" ||
      status === "failed" ||
      !(await controller.list(await ensureRuntimeOwnerId())).some(
        (h) => h.externalId === handle.externalId,
      )
    ) {
      await terminateRuntime(runtime, controller, "Runtime died after socket disconnect");
      await recoverRuntime(runtimeId, "Runtime died after socket disconnect");
    }
  });
}

function socketRuntimeId(data: unknown): string | null {
  const runtimeId = (data as { runtimeId?: unknown } | null)?.runtimeId;
  return typeof runtimeId === "string" ? runtimeId : null;
}

export function startRuntimeRecovery(): void {
  if (subscriptions.length) return;
  subscriptions = [
    realtimeBus.subscribe("worker.socket.connected", (data) => {
      const id = socketRuntimeId(data);
      if (!id) return;
      sockets.set(id, (sockets.get(id) ?? 0) + 1);
      clearTimeout(socketChecks.get(id));
      socketChecks.delete(id);
    }),
    realtimeBus.subscribe("worker.socket.disconnected", (data) => {
      const id = socketRuntimeId(data);
      if (!id) return;
      const count = Math.max(0, (sockets.get(id) ?? 1) - 1);
      if (count) {
        sockets.set(id, count);
        return;
      }
      sockets.delete(id);
      if (!isRuntimePoolsEnabled() || !isMultiRuntimeEnabled()) return;
      if (socketChecks.has(id)) return;
      const seconds = Number(process.env.RUNTIME_SOCKET_GRACE_SEC);
      const delay = Number.isInteger(seconds) && seconds >= 0 ? seconds : 60;
      const timer = setTimeout(() => {
        socketChecks.delete(id);
        void checkDisconnectedRuntime(id).catch(reportRecoveryError);
      }, delay * 1000);
      timer.unref?.();
      socketChecks.set(id, timer);
    }),
  ];
}

export function stopRuntimeRecovery(): void {
  for (const unsubscribe of subscriptions) unsubscribe();
  subscriptions = [];
  for (const timer of socketChecks.values()) clearTimeout(timer);
  socketChecks.clear();
  sockets.clear();
}
