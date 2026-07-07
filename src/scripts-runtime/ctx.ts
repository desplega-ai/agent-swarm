import { createApiRegistryClient } from "./api-client";
import type {
  ScriptApiConnectionDescriptor,
  ScriptApiRegistryClient,
  ScriptMcpConnectionDescriptor,
  ScriptMcpRegistryClient,
} from "./api-types";
import { createMcpRegistryClient } from "./mcp-client";
import { stdlib } from "./stdlib";
import type { SwarmConfig } from "./swarm-config";
import { createSwarmSdk } from "./swarm-sdk";

export type RuntimeCtx = {
  swarm: Record<string, unknown> & { config: SwarmConfig };
  api: ScriptApiRegistryClient;
  mcp: ScriptMcpRegistryClient;
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
  mcpConnections,
}: {
  swarmConfig: SwarmConfig;
  apiConnections?: ScriptApiConnectionDescriptor[];
  mcpConnections?: ScriptMcpConnectionDescriptor[];
}): RuntimeCtx {
  const swarm = createSwarmSdk(swarmConfig) as Record<string, unknown> & { config: SwarmConfig };
  swarm.config = swarmConfig;
  return {
    swarm,
    api: createApiRegistryClient(apiConnections),
    mcp: createMcpRegistryClient(mcpConnections, swarmConfig),
    stdlib,
    logger: console,
  };
}
