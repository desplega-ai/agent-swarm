import {
  createSandbox,
  E2BApiError,
  e2bSdkConnectionOptions,
  killSandbox,
  listSandboxes,
  setSandboxTimeout,
  startDetachedProcess,
} from "../e2b/dispatch";
import { redactWithEnv } from "../e2b/env";
import {
  type ConfigStatus,
  type ProvisionRequest,
  RUNTIME_LABELS,
  type RuntimeHandle,
  type RuntimeProvider,
  type RuntimeStatus,
  type RuntimeTargetConfig,
} from "./types";
import { resolveWorkerApiUrl } from "./worker-api-url";

/**
 * E2B runtime provider. Wraps the existing DB-free helpers in src/e2b/dispatch.ts:
 * create a sandbox from a worker template, then start /docker-entrypoint.sh as a
 * tracked background command (the template's start command is `sleep infinity`).
 *
 * Target config:
 * - E2B_API_KEY (required)
 * - E2B_API_BASE (optional)
 * - E2B_TTL_SEC (optional, default 900)
 * - WORKER_API_URL (required HTTPS URL, with deployment fallbacks)
 */
const DEFAULT_TTL_SEC = 900;

function leaseTtlSec(target: RuntimeTargetConfig): number {
  const ttlSec = Number(target.E2B_TTL_SEC ?? DEFAULT_TTL_SEC);
  if (!Number.isInteger(ttlSec) || ttlSec <= 0) {
    throw new Error("E2B_TTL_SEC must be a positive integer");
  }
  return ttlSec;
}

async function withRedactedErrors<T>(
  target: RuntimeTargetConfig,
  run: () => Promise<T>,
  env: Record<string, string> = {},
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new Error(redactWithEnv(String(err), { ...env, E2B_API_KEY: target.E2B_API_KEY ?? "" }));
  }
}

export class E2BRuntimeProvider implements RuntimeProvider {
  readonly kind = "e2b" as const;
  readonly traits;

  constructor(target: RuntimeTargetConfig = {}) {
    const maxContinuousSec = Number(target.E2B_MAX_CONTINUOUS_SEC ?? 3600);
    if (!Number.isInteger(maxContinuousSec) || maxContinuousSec <= 0) {
      throw new Error("E2B_MAX_CONTINUOUS_SEC must be a positive integer");
    }
    this.traits = {
      canProvision: true,
      ephemeralDisk: true,
      supportsPause: true,
      maxTtlSec: 24 * 3600,
      maxContinuousSec,
    };
  }

  checkConfig(target: RuntimeTargetConfig): ConfigStatus {
    const missing = target.E2B_API_KEY ? [] : ["E2B_API_KEY"];
    const workerUrl = resolveWorkerApiUrl(target);
    try {
      if (!workerUrl || new URL(workerUrl).protocol !== "https:") missing.push("WORKER_API_URL");
    } catch {
      missing.push("WORKER_API_URL");
    }
    return missing.length
      ? {
          ready: false,
          missing,
          hint: `E2B requires ${missing.join(" and ")}. WORKER_API_URL must use HTTPS.`,
        }
      : { ready: true, missing: [] };
  }

  private apiKey(target: RuntimeTargetConfig): string {
    if (!target.E2B_API_KEY) throw new Error("Missing E2B_API_KEY");
    return target.E2B_API_KEY;
  }

  async provision(target: RuntimeTargetConfig, req: ProvisionRequest): Promise<RuntimeHandle> {
    return withRedactedErrors(
      target,
      async () => {
        const apiKey = this.apiKey(target);
        const sandbox = await createSandbox({
          apiKey,
          apiBase: target.E2B_API_BASE,
          template: req.image,
          timeoutSec: req.ttlSec ?? leaseTtlSec(target),
          envVars: req.env,
          metadata: {
            ...req.labels,
            [RUNTIME_LABELS.owner]: req.ownerId,
            [RUNTIME_LABELS.runtimeId]: req.runtimeId,
            [RUNTIME_LABELS.poolId]: req.poolId,
            [RUNTIME_LABELS.agentId]: req.agentId,
          },
        });
        try {
          await startDetachedProcess({
            sandbox,
            apiKey,
            apiBase: target.E2B_API_BASE,
            env: req.env,
            command: "/docker-entrypoint.sh",
            role: "worker",
            cwd: "/workspace",
          });
        } catch (err) {
          await killSandbox(sandbox.sandboxID, apiKey, target.E2B_API_BASE).catch(() => {});
          throw err;
        }
        const leaseExpiresAt = sandbox.endAt ?? sandbox.expiresAt;
        return {
          kind: "e2b",
          externalId: sandbox.sandboxID,
          ...(sandbox.startedAt ? { createdAt: sandbox.startedAt } : {}),
          ...(leaseExpiresAt ? { meta: { leaseExpiresAt } } : {}),
        };
      },
      req.env,
    );
  }

  async terminate(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    return withRedactedErrors(target, async () => {
      try {
        await killSandbox(handle.externalId, this.apiKey(target), target.E2B_API_BASE);
      } catch (err) {
        if (!(err instanceof E2BApiError) || err.statusCode !== 404) throw err;
      }
    });
  }

  async status(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<RuntimeStatus> {
    return withRedactedErrors(target, async () => {
      const { Sandbox, SandboxNotFoundError } = await import("e2b");
      const options = e2bSdkConnectionOptions(this.apiKey(target), {}, target.E2B_API_BASE);
      try {
        const info = await Sandbox.getInfo(handle.externalId, options);
        return info.state === "paused" ? "paused" : "running";
      } catch (err) {
        if (err instanceof SandboxNotFoundError) return "exited";
        throw err;
      }
    });
  }

  async list(target: RuntimeTargetConfig, ownerId: string): Promise<RuntimeHandle[]> {
    return withRedactedErrors(target, async () => {
      const rows = await listSandboxes(this.apiKey(target), target.E2B_API_BASE);
      return rows
        .filter(
          (row) =>
            row.metadata?.[RUNTIME_LABELS.runtimeId] &&
            row.metadata[RUNTIME_LABELS.owner] === ownerId,
        )
        .map((row) => ({
          kind: "e2b",
          externalId: row.sandboxID,
          createdAt: row.startedAt,
          meta: row.metadata,
        }));
    });
  }

  async renew(
    target: RuntimeTargetConfig,
    handle: RuntimeHandle,
    ttlSec: number,
  ): Promise<{ endAt: string }> {
    return withRedactedErrors(target, async () => {
      const ttl = await setSandboxTimeout({
        sandboxId: handle.externalId,
        apiKey: this.apiKey(target),
        apiBase: target.E2B_API_BASE,
        timeoutMs: ttlSec * 1000,
      });
      if (!ttl.expiresAt) throw new Error("E2B did not return the renewed expiry");
      return { endAt: ttl.expiresAt };
    });
  }

  async pause(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    return withRedactedErrors(target, async () => {
      const { Sandbox } = await import("e2b");
      const options = e2bSdkConnectionOptions(this.apiKey(target), {}, target.E2B_API_BASE);
      await Sandbox.betaPause(handle.externalId, options);
    });
  }

  async resume(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    return withRedactedErrors(target, async () => {
      const { Sandbox } = await import("e2b");
      const options = e2bSdkConnectionOptions(this.apiKey(target), {}, target.E2B_API_BASE);
      await Sandbox.connect(handle.externalId, {
        ...options,
        timeoutMs: leaseTtlSec(target) * 1000,
      });
    });
  }
}
