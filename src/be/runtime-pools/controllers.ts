import { createRuntimeProvider } from "../../runtime-providers";
import { BuiltinController, type ControllerCommands } from "../../runtime-providers/controller";
import { scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient, getSwarmConfigs, upsertSwarmConfig } from "../db";
import { checkE2bControllerConfig, getRuntimeController, getRuntimeControllerTarget } from "./db";

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

export async function getControllerCommands(controllerId: string): Promise<ControllerCommands> {
  try {
    const controller = await getRuntimeController(controllerId);
    if (!controller) throw new Error("Runtime controller does not exist");
    if (controller.placement !== "builtin") throw new Error("Remote controller is not available");
    const target = await getRuntimeControllerTarget(controller);
    const config =
      controller.kind === "e2b"
        ? await checkE2bControllerConfig(controller, target)
        : (await createRuntimeProvider(controller.kind, target)).checkConfig(target);
    if (!config.ready)
      throw new Error(config.hint ?? `Missing configuration: ${config.missing.join(", ")}`);
    const provider = await createRuntimeProvider(controller.kind, target);
    return new BuiltinController(controllerId, provider, target, target.WORKER_API_URL);
  } catch (error) {
    throw new Error(scrubSecrets(String(error)));
  }
}
