import { realtimeBus } from "../../realtime/bus";
import { canProvisionKind } from "../../runtime-providers";
import { isMultiRuntimeEnabled } from "../../utils/multi-runtime";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient, getTaskById } from "../db";
import { getRuntimeInstanceById, markRuntimeTerminated } from "../multi-runtime";
import { ensureRuntimeOwnerId, getControllerCommands } from "./controllers";
import { getRuntimePool, resolvePoolDelivery } from "./db";
import { runtimeHandle, terminateRuntime } from "./supervisor";

const recovering = new Map<string, Promise<void>>();
const socketChecks = new Map<string, ReturnType<typeof setTimeout>>();
const sockets = new Map<string, number>();
let subscriptions: Array<() => void> = [];

function reportRecoveryError(error: unknown): void {
  console.error("[runtime-pools] Recovery failed:", scrubSecrets(String(error)));
}

export async function recoverRuntime(runtimeId: string, reason: string): Promise<void> {
  const existing = recovering.get(runtimeId);
  if (existing) return await existing;
  const recovery = (async () => {
    await markRuntimeTerminated(runtimeId, scrubSecrets(reason));
    const sessions = await getDbClient().query<{ taskId: string }>(
      "SELECT taskId FROM active_sessions WHERE runtimeInstanceId = ?",
      [runtimeId],
    );
    if (!sessions.length) return;
    const { remediateTaskForDeadRuntime } = await import("../../heartbeat/heartbeat");
    for (const session of sessions) {
      const task = await getTaskById(session.taskId);
      if (task?.status === "in_progress") await remediateTaskForDeadRuntime(task, reason);
      else
        await getDbClient().run(
          "DELETE FROM active_sessions WHERE taskId = ? AND runtimeInstanceId = ?",
          [session.taskId, runtimeId],
        );
    }
  })();
  recovering.set(runtimeId, recovery);
  try {
    await recovery;
  } finally {
    recovering.delete(runtimeId);
  }
}

export async function fenceStalledRuntime(runtimeId: string, reason: string): Promise<boolean> {
  if (!isRuntimePoolsEnabled() || !isMultiRuntimeEnabled()) return false;
  const runtime = await getRuntimeInstanceById(runtimeId);
  const pool = runtime?.poolId ? await getRuntimePool(runtime.poolId) : null;
  if (!runtime || !pool || !canProvisionKind(pool.kind)) return false;
  try {
    if (runtime.controllerId)
      await terminateRuntime(runtime, await getControllerCommands(runtime.controllerId), reason);
  } catch (error) {
    reportRecoveryError(error);
  }
  await markRuntimeTerminated(runtimeId, scrubSecrets(reason));
  return true;
}

export async function checkDisconnectedRuntime(runtimeId: string): Promise<void> {
  if (!isRuntimePoolsEnabled() || !isMultiRuntimeEnabled()) return;
  const runtime = await getRuntimeInstanceById(runtimeId);
  if (!runtime || runtime.status !== "active" || !runtime.poolId || !runtime.controllerId) return;
  const pool = await getRuntimePool(runtime.poolId);
  if (!pool || !canProvisionKind(pool.kind) || resolvePoolDelivery(pool) !== "push") return;
  const handle = runtimeHandle(runtime);
  if (!handle) return;
  const controller = await getControllerCommands(runtime.controllerId);
  const status = (await controller.status([handle]))[handle.externalId];
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
      if (!id || !isRuntimePoolsEnabled() || !isMultiRuntimeEnabled()) return;
      const count = Math.max(0, (sockets.get(id) ?? 1) - 1);
      if (count) {
        sockets.set(id, count);
        return;
      }
      sockets.delete(id);
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
