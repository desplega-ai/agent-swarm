import { createApiRegistryClient } from "./api-client";
import type {
  ScriptApiConnectionDescriptor,
  ScriptApiRegistryClient,
  ScriptMcpConnectionDescriptor,
  ScriptMcpRegistryClient,
} from "./api-types";
import type { ScriptAgentFsDescriptor, ScriptCaller } from "./executors/types";
import { createMcpRegistryClient } from "./mcp-client";
import {
  createScriptDb,
  DEFAULT_SCRIPT_DB_DIALECT,
  type ScriptDb,
  type ScriptDbDialect,
} from "./script-db";
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
  caller: ScriptCaller;
  swarm: Record<string, unknown> & { config: SwarmConfig };
  api: ScriptApiRegistryClient;
  mcp: ScriptMcpRegistryClient;
  fs: ScriptFs;
  sh: (command: string, options?: ScriptShOptions) => Promise<ScriptShResult>;
  db: ScriptDb;
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
  dbDialect = DEFAULT_SCRIPT_DB_DIALECT,
  caller = null,
  signal,
  namespaces,
}: {
  swarmConfig: SwarmConfig;
  apiConnections?: ScriptApiConnectionDescriptor[];
  mcpConnections?: ScriptMcpConnectionDescriptor[];
  agentFs?: ScriptAgentFsDescriptor;
  /** `ctx.db.dialect`, from the run's config payload. */
  dbDialect?: ScriptDbDialect;
  caller?: ScriptCaller;
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
    caller: caller === null ? null : Object.freeze(JSON.parse(JSON.stringify(caller))),
    swarm,
    api: createApiRegistryClient(apiConnections, { swarmConfig }),
    mcp: createMcpRegistryClient(mcpConnections, swarmConfig),
    fs,
    sh,
    // ctx.swarm is a Proxy: every string key is a tool call, so db_query is always defined.
    db: createScriptDb(dbDialect, swarm.db_query as (args: unknown) => Promise<unknown>),
    stdlib,
    logger: console,
  };
}
