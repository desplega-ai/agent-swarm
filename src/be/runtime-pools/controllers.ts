import { createRuntimeProvider } from "../../runtime-providers";
import {
  BuiltinController,
  type ControllerCommands,
  ControllerOfflineError,
} from "../../runtime-providers/controller";
import { isRuntimePoolsEnabled } from "../../utils/runtime-pools-flag";
import { registerVolatileSecret, scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient, getSwarmConfigs, upsertSwarmConfig } from "../db";
import { getRuntimeController, getRuntimeControllerSecrets } from "./db";
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
  const configured = Number(process.env.RUNTIME_CONTROLLER_GRACE_SEC ?? 120);
  const graceMs =
    (Number.isInteger(configured) && configured >= 0 && configured <= 86_400 ? configured : 120) *
    1000;
  const rows = await getDbClient().query<{
    id: string;
    status: string;
    updated_at: string;
    last_seen_at: string | null;
  }>(
    "SELECT id, status, updated_at, last_seen_at FROM runtime_controllers WHERE placement = 'remote'",
  );
  for (const row of rows) {
    if (remoteControllerSession(row.id)) continue;
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
      if (remoteControllerSession(row.id)) break;
      await recoverRuntime(runtime.id, "Remote controller disconnect grace expired");
    }
  }
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
    const secrets = await getRuntimeControllerSecrets(controllerId);
    for (const [key, value] of Object.entries(secrets))
      registerVolatileSecret(value, `runtime-controller:${controllerId}:${key}`);
    const target = {
      DOCKER_HOST: process.env.DOCKER_HOST,
      DOCKER_NETWORK: process.env.DOCKER_NETWORK,
      DOCKER_EXTRA_HOSTS: process.env.DOCKER_EXTRA_HOSTS,
      ...controller.config,
      ...secrets,
    };
    const provider = await createRuntimeProvider(controller.kind, target);
    const config = provider.checkConfig(target);
    if (!config.ready)
      throw new Error(config.hint ?? `Missing configuration: ${config.missing.join(", ")}`);
    return new BuiltinController(controllerId, provider, target, controller.config.WORKER_API_URL);
  } catch (error) {
    if (error instanceof ControllerOfflineError) throw error;
    throw new Error(scrubSecrets(String(error)));
  }
}
