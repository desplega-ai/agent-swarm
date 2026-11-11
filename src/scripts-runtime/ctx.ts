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
import type { SdkNamespaceRegistry } from "./sdk-allowlist";
import { stdlib } from "./stdlib";
import type { SwarmConfig } from "./swarm-config";
import { createNamespaceClients, createSwarmSdk } from "./swarm-sdk";

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
  /** Registered `SDK_NAMESPACES` clients (`ctx.<ns>.<method>`). */
  [namespace: string]: unknown;
};

export function buildCtx({
  swarmConfig,
  apiConnections,
  mcpConnections,
  agentFs,
  signal,
  namespaces,
}: {
  swarmConfig: SwarmConfig;
  apiConnections?: ScriptApiConnectionDescriptor[];
  mcpConnections?: ScriptMcpConnectionDescriptor[];
  agentFs?: ScriptAgentFsDescriptor;
  /** Aborts in-flight `ctx.sh` commands when the run ends (quickjs passes its run signal). */
  signal?: AbortSignal;
  /** Tests inject a fixture; production uses `SDK_NAMESPACES`. */
  namespaces?: SdkNamespaceRegistry;
}): RuntimeCtx {
  const swarm = Object.assign(createSwarmSdk(swarmConfig, { signal }), { config: swarmConfig });
  const { fs, sh } = createScriptFs(agentFs, signal);
  return {
    // Spread first: assertNamespaces already rejects a namespace named like a ctx key.
    ...createNamespaceClients(swarmConfig, { signal, registry: namespaces }),
    swarm,
    api: createApiRegistryClient(apiConnections, { swarmConfig }),
    mcp: createMcpRegistryClient(mcpConnections, swarmConfig),
    fs,
    sh,
    stdlib,
    logger: console,
  };
}
