import { createApiRegistryClient } from "./api-client";
import type { ScriptApiConnectionDescriptor, ScriptApiRegistryClient } from "./api-types";
import { stdlib } from "./stdlib";
import type { SwarmConfig } from "./swarm-config";
import { createSwarmSdk } from "./swarm-sdk";

export type RuntimeCtx = {
  swarm: Record<string, unknown> & { config: SwarmConfig };
  api: ScriptApiRegistryClient;
  stdlib: typeof stdlib;
  logger: {
    log: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
};

export function buildCtx({
  swarmConfig,
  apiConnections,
}: {
  swarmConfig: SwarmConfig;
  apiConnections?: ScriptApiConnectionDescriptor[];
}): RuntimeCtx {
  const swarm = createSwarmSdk(swarmConfig) as Record<string, unknown> & { config: SwarmConfig };
  swarm.config = swarmConfig;
  return {
    swarm,
    api: createApiRegistryClient(apiConnections),
    stdlib,
    logger: console,
  };
}
