import { createRuntimeProvider } from "../../runtime-providers";
import {
  BuiltinController,
  type ControllerCommands,
  ControllerOfflineError,
} from "../../runtime-providers/controller";
import { RUNTIME_LABELS, type RuntimeHandle } from "../../runtime-providers/types";
import { resolveWorkerApiUrl } from "../../runtime-providers/worker-api-url";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient, getSwarmConfigs, upsertSwarmConfig } from "../db";
import { markRuntimeTerminated } from "../multi-runtime";
import { validateControllerGraceSec } from "../swarm-config-guard";
import { checkE2bControllerConfig, getRuntimeController, getRuntimeControllerTarget } from "./db";
import { remoteControllerSession } from "./remote-controller";

let ownerId: Promise<string> | null = null;

export function clearRuntimeOwnerIdCache(): void {
  ownerId = null;
}

export async function ensureRuntimeOwnerId(): Promise<string> {
  if (!ownerId) {
    ownerId = readRuntimeOwnerId().catch((error) => {
      ownerId = null;
      throw error;
    });
  }
  return await ownerId;
}

async function readRuntimeOwnerId(): Promise<string> {
  const existing = (await getSwarmConfigs({ scope: "global", key: "runtime_owner_id" }))[0];
  if (existing) return existing.value;
  return await getDbClient().transaction(async () => {
    const existing = (await getSwarmConfigs({ scope: "global", key: "runtime_owner_id" }))[0];
    if (existing) return existing.value;
    const row = await upsertSwarmConfig({
      scope: "global",
      key: "runtime_owner_id",
      value: crypto.randomUUID(),
      description: "Owner of provisioned worker runtimes",
    });
    return row.value;
  });
}

export async function reconcileDisconnectedControllers(
  recoverRuntime: (runtimeId: string, reason: string) => Promise<void>,
  now = new Date(),
): Promise<void> {
  if (!isRuntimePoolsEnabled()) return;
  const configured = process.env.RUNTIME_CONTROLLER_GRACE_SEC;
  const graceMs =
    (validateControllerGraceSec(configured) === null ? Number(configured) : 120) * 1000;
  const rows = await getDbClient().query<{
    id: string;
    status: string;
    updated_at: string;
    last_seen_at: string | null;
  }>(
    "SELECT id, status, updated_at, last_seen_at FROM runtime_controllers WHERE placement = 'remote'",
  );
  for (const row of rows) {
    if (row.status === "online" && remoteControllerSession(row.id)) continue;
    // An API restart loses sessions even when the persisted controller status remains online.
    if (row.status === "online") {
      await getDbClient().run(
        "UPDATE runtime_controllers SET status = 'offline', updated_at = ?, last_seen_at = ? WHERE id = ? AND status = 'online'",
        [now.toISOString(), now.toISOString(), row.id],
      );
      continue;
    }
    if (now.getTime() - Date.parse(row.last_seen_at ?? row.updated_at) < graceMs) continue;
    const runtimes = await getDbClient().query<{ id: string }>(
      "SELECT id FROM runtime_instances WHERE controller_id = ? AND status != 'offline'",
      [row.id],
    );
    for (const runtime of runtimes) {
      if (
        remoteControllerSession(row.id) &&
        (await getRuntimeController(row.id))?.status === "online"
      )
        break;
      await recoverRuntime(runtime.id, "Remote controller disconnect grace expired");
    }
  }
}

export async function reconcileRemoteProvisions(
  controllerId: string,
  handles: RuntimeHandle[],
  ownerId: string,
): Promise<void> {
  await getDbClient().transaction(async (tx) => {
    for (const handle of handles) {
      const labels = handle.meta;
      const runtimeId = labels?.[RUNTIME_LABELS.runtimeId];
      if (labels?.[RUNTIME_LABELS.owner] !== ownerId || !runtimeId) continue;
      await tx.run(
        `UPDATE runtime_instances SET external_handle = ?, updated_at = ?
         WHERE id = ? AND controller_id = ? AND agent_id = ? AND pool_id = ?
         AND status != 'offline' AND external_handle IS NULL`,
        [
          JSON.stringify(handle),
          new Date().toISOString(),
          runtimeId,
          controllerId,
          labels[RUNTIME_LABELS.agentId] ?? "",
          labels[RUNTIME_LABELS.poolId] ?? "",
        ],
      );
    }
    const missing = await tx.query<{ id: string }>(
      "SELECT id FROM runtime_instances WHERE controller_id = ? AND status = 'provisioning' AND external_handle IS NULL",
      [controllerId],
    );
    for (const runtime of missing)
      await markRuntimeTerminated(
        runtime.id,
        "Controller list did not report the ambiguous provision",
      );
  });
}

export async function getControllerCommands(controllerId: string): Promise<ControllerCommands> {
  try {
    const controller = await getRuntimeController(controllerId);
    if (!controller) throw new Error("Runtime controller does not exist");
    if (controller.placement === "remote") {
      const session = remoteControllerSession(controllerId);
      if (!session || controller.status !== "online")
        throw new ControllerOfflineError(controllerId);
      return session;
    }
    const target = await getRuntimeControllerTarget(controller);
    const config =
      controller.kind === "e2b"
        ? await checkE2bControllerConfig(controller, target)
        : (await createRuntimeProvider(controller.kind, target)).checkConfig(target);
    if (!config.ready)
      throw new Error(config.hint ?? `Missing configuration: ${config.missing.join(", ")}`);
    const provider = await createRuntimeProvider(controller.kind, target);
    return new BuiltinController(controllerId, provider, target, resolveWorkerApiUrl(target));
  } catch (error) {
    if (error instanceof ControllerOfflineError) throw error;
    throw new Error(scrubSecrets(String(error)));
  }
}
