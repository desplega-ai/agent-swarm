/**
 * Runtime providers: one adapter per infrastructure kind (docker, e2b, k8s, ...)
 * that starts and stops worker runtimes on demand. Mirrors the harness-provider
 * shape in `src/providers/types.ts` (adapter + traits + lazy factory).
 *
 * DB-free by design: the same adapters run inside the API (built-in controller)
 * and inside a remote `swarm-controller` process. The API-side supervisor owns
 * the DB rows; adapters only talk to infrastructure.
 *
 * SPIKE: shape under evaluation in the push-based-workers brainstorm
 * (thoughts/taras/brainstorms/2026-10-10-push-based-workers.md).
 */

export type RuntimeProviderKind = "static" | "docker" | "e2b" | "k8s";

export interface RuntimeProviderTraits {
  /** false for "static": operator-managed workers the swarm never starts. */
  canProvision: boolean;
  /** Workspace is lost when the runtime exits. */
  ephemeralDisk: boolean;
  /** Provider can pause and resume a runtime (not used yet). */
  supportsPause: boolean;
  /** Provider hard cap on runtime lifetime, if any. */
  maxTtlSec?: number;
}

/** Credentials and location of one infrastructure target (one controller). */
export type RuntimeTargetConfig = Record<string, string | undefined>;

export interface ConfigStatus {
  ready: boolean;
  missing: string[];
  hint?: string;
}

export interface ProvisionRequest {
  /** Pre-allocated runtime id (the runtime_instances row in the full design). */
  runtimeId: string;
  agentId: string;
  poolId: string;
  /** Docker image, E2B template, or k8s image. */
  image: string;
  /** Worker env: MCP_BASE_URL, AGENT_ID, API key or scoped token, pool env. */
  env: Record<string, string>;
  resources?: { cpu?: number; memoryMb?: number };
  ttlSec?: number;
  /** Ownership labels, used by list() to find runtimes this swarm started. */
  labels: Record<string, string>;
}

export interface RuntimeHandle {
  kind: RuntimeProviderKind;
  /** Container id, sandbox id, or pod name. */
  externalId: string;
  meta?: Record<string, string>;
}

export type RuntimeStatus = "starting" | "running" | "exited" | "failed" | "unknown";

export interface RuntimeProvider {
  readonly kind: RuntimeProviderKind;
  readonly traits: RuntimeProviderTraits;
  /** Validate the target config before use (like a harness checkCredentials). */
  checkConfig(target: RuntimeTargetConfig): ConfigStatus;
  /** Start one runtime. Resolves when the infra accepted it, not when the worker registered. */
  provision(target: RuntimeTargetConfig, req: ProvisionRequest): Promise<RuntimeHandle>;
  terminate(target: RuntimeTargetConfig, handle: RuntimeHandle, reason: string): Promise<void>;
  status(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<RuntimeStatus>;
  /** Every runtime this swarm owns on the target, found by labels. Used to reap orphans. */
  list(target: RuntimeTargetConfig): Promise<RuntimeHandle[]>;
}

/** Label keys every provider stamps on the runtimes it starts. */
export const RUNTIME_LABELS = {
  runtimeId: "swarm.runtime-id",
  poolId: "swarm.pool-id",
  agentId: "swarm.agent-id",
} as const;
