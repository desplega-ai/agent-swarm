import { createSandbox, killSandbox, listSandboxes, startDetachedProcess } from "../e2b/dispatch";
import {
  type ConfigStatus,
  type ProvisionRequest,
  RUNTIME_LABELS,
  type RuntimeHandle,
  type RuntimeProvider,
  type RuntimeStatus,
  type RuntimeTargetConfig,
} from "./types";

/**
 * E2B runtime provider. Wraps the existing DB-free helpers in src/e2b/dispatch.ts:
 * create a sandbox from a worker template, then start /docker-entrypoint.sh as a
 * tracked background command (the template's start command is `sleep infinity`).
 *
 * Target config:
 * - E2B_API_KEY (required)
 * - E2B_API_BASE (optional)
 */
const DEFAULT_TTL_SEC = 3600;

export class E2BRuntimeProvider implements RuntimeProvider {
  readonly kind = "e2b" as const;
  readonly traits = {
    canProvision: true,
    ephemeralDisk: true,
    supportsPause: true,
    maxTtlSec: 24 * 3600,
  };

  checkConfig(target: RuntimeTargetConfig): ConfigStatus {
    return target.E2B_API_KEY
      ? { ready: true, missing: [] }
      : { ready: false, missing: ["E2B_API_KEY"] };
  }

  private apiKey(target: RuntimeTargetConfig): string {
    if (!target.E2B_API_KEY) throw new Error("Missing E2B_API_KEY");
    return target.E2B_API_KEY;
  }

  async provision(target: RuntimeTargetConfig, req: ProvisionRequest): Promise<RuntimeHandle> {
    const apiKey = this.apiKey(target);
    const sandbox = await createSandbox({
      apiKey,
      apiBase: target.E2B_API_BASE,
      template: req.image,
      timeoutSec: req.ttlSec ?? DEFAULT_TTL_SEC,
      envVars: req.env,
      metadata: {
        ...req.labels,
        [RUNTIME_LABELS.runtimeId]: req.runtimeId,
        [RUNTIME_LABELS.poolId]: req.poolId,
        [RUNTIME_LABELS.agentId]: req.agentId,
      },
    });
    await startDetachedProcess({
      sandbox,
      apiKey,
      apiBase: target.E2B_API_BASE,
      env: req.env,
      command: "/docker-entrypoint.sh",
      role: "worker",
      cwd: "/workspace",
    });
    return { kind: "e2b", externalId: sandbox.sandboxID };
  }

  async terminate(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    await killSandbox(handle.externalId, this.apiKey(target), target.E2B_API_BASE);
  }

  async status(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<RuntimeStatus> {
    const rows = await this.list(target);
    return rows.some((row) => row.externalId === handle.externalId) ? "running" : "exited";
  }

  async list(target: RuntimeTargetConfig): Promise<RuntimeHandle[]> {
    const rows = await listSandboxes(this.apiKey(target), target.E2B_API_BASE);
    return rows
      .filter((row) => row.metadata?.[RUNTIME_LABELS.runtimeId])
      .map((row) => ({ kind: "e2b", externalId: row.sandboxID, meta: row.metadata }));
  }
}
