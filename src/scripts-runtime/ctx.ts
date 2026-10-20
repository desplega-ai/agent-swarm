import { createApiRegistryClient } from "./api-client";
import type {
  ScriptApiConnectionDescriptor,
  ScriptApiRegistryClient,
  ScriptMcpConnectionDescriptor,
  ScriptMcpRegistryClient,
} from "./api-types";
import type { ScriptAgentFsDescriptor } from "./executors/types";
import { createMcpRegistryClient } from "./mcp-client";
import {
  createScriptFs,
  type ScriptFs,
  type ScriptShOptions,
  type ScriptShResult,
} from "./script-fs";
import { stdlib } from "./stdlib";
import type { SwarmConfig } from "./swarm-config";
import { createSwarmSdk } from "./swarm-sdk";

export type RuntimeCtx = {
  swarm: Record<string, unknown> & { config: SwarmConfig };
  api: ScriptApiRegistryClient;
  mcp: ScriptMcpRegistryClient;
  fs: ScriptFs;
  sh: (command: string, options?: ScriptShOptions) => Promise<ScriptShResult>;
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
  agentFs,
  signal,
}: {
  swarmConfig: SwarmConfig;
  apiConnections?: ScriptApiConnectionDescriptor[];
  mcpConnections?: ScriptMcpConnectionDescriptor[];
  agentFs?: ScriptAgentFsDescriptor;
  /** Aborts in-flight `ctx.sh` commands when the run ends (quickjs passes its run signal). */
  signal?: AbortSignal;
}): RuntimeCtx {
  const swarm = Object.assign(createSwarmSdk(swarmConfig), { config: swarmConfig });
  const { fs, sh } = createScriptFs(agentFs, signal);
  return {
    swarm,
    api: createApiRegistryClient(apiConnections, { swarmConfig }),
    mcp: createMcpRegistryClient(mcpConnections, swarmConfig),
    fs,
    sh,
    stdlib,
    logger: console,
  };
}
