import { createRuntimeProvider } from "../../runtime-providers";
import { BuiltinController, type ControllerCommands } from "../../runtime-providers/controller";
import { registerVolatileSecret, scrubSecrets } from "../../utils/secret-scrubber";
import { getDbClient, getSwarmConfigs, upsertSwarmConfig } from "../db";
import { getRuntimeController, getRuntimeControllerSecrets } from "./db";

export async function ensureRuntimeOwnerId(): Promise<string> {
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
    throw new Error(scrubSecrets(String(error)));
  }
}
