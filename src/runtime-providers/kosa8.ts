import type { CloudSandbox, CloudSandboxInfo, Kosa8Cloud } from "@kosa8/sdk";
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
 * kosa8 runtime provider. Each runtime is one kosa8 Cloud sandbox, a microVM
 * booted from the pool image itself, with the worker env set on the sandbox.
 * The worker starts as a background command, the same entrypoint the docker
 * provider runs as the container's ENTRYPOINT.
 *
 * Target config:
 * - KOSA8_API_KEY (required)
 * - KOSA8_API_URL (optional API endpoint, default https://api.kosa8.com)
 * - KOSA8_REGION (optional: us-ash1, eu-hel1, or the area alone, us or eu)
 * - KOSA8_SNAPSHOT (optional snap_… to start from, e.g. one with the worker image booted)
 * - KOSA8_DELETE_AFTER_SEC (optional wall-clock lifetime after which kosa8 deletes the sandbox)
 * - KOSA8_START_TIMEOUT_SEC (optional, default 600: cold boot, image pull included)
 * - KOSA8_TEARDOWN_TIMEOUT_SEC (optional, default 30: waiting for kosa8 to confirm a delete)
 * - WORKER_API_URL (required HTTPS URL, with deployment fallbacks)
 */
const WORKER_ENTRYPOINT = "/docker-entrypoint.sh";
/** The worker's output, kept out of the background command's own output. */
const WORKER_LOG = "/workspace/.swarm-worker.log";
/** Label holding the id (bg_…) of the background command that runs the worker. */
export const KOSA8_WORKER_EXEC_LABEL = "kosa8.worker-exec";
const DEFAULT_START_TIMEOUT_SEC = 600;
const DEFAULT_TEARDOWN_TIMEOUT_SEC = 30;
const TEARDOWN_POLL_MS = 200;
/** kosa8 keeps at most 64 env vars on a sandbox. */
const MAX_ENV = 64;
const SECONDS_KEYS = [
  "KOSA8_DELETE_AFTER_SEC",
  "KOSA8_START_TIMEOUT_SEC",
  "KOSA8_TEARDOWN_TIMEOUT_SEC",
] as const;

/** kosa8 sizes (vCPU x GiB), smallest first. */
const SIZES = [
  { vcpu: 2, memoryMb: 4096, size: "2x4" },
  { vcpu: 4, memoryMb: 8192, size: "4x8" },
  { vcpu: 8, memoryMb: 16384, size: "8x16" },
  { vcpu: 16, memoryMb: 32768, size: "16x32" },
] as const;

const clients = new Map<string, Promise<Kosa8Cloud>>();

async function client(target: RuntimeTargetConfig): Promise<Kosa8Cloud> {
  if (!target.KOSA8_API_KEY) throw new Error("Missing KOSA8_API_KEY");
  const key = `${target.KOSA8_API_URL ?? ""}\n${target.KOSA8_API_KEY}`;
  let cloud = clients.get(key);
  if (!cloud) {
    cloud = import("@kosa8/sdk").then(
      ({ Kosa8Cloud }) =>
        // env: {} so only the target config picks the key and endpoint.
        new Kosa8Cloud({
          apiKey: target.KOSA8_API_KEY,
          baseUrl: target.KOSA8_API_URL || undefined,
          env: {},
        }),
    );
    clients.set(key, cloud);
  }
  return cloud;
}

/** A duration in whole seconds from target config; undefined when unset. */
function seconds(
  target: RuntimeTargetConfig,
  key: (typeof SECONDS_KEYS)[number],
): number | undefined {
  if (target[key] === undefined || target[key] === "") return undefined;
  const sec = Number(target[key]);
  if (!Number.isInteger(sec) || sec <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  if (key === "KOSA8_DELETE_AFTER_SEC" && (sec < 60 || sec > 7_776_000)) {
    throw new Error(`${key} must be between 60 and 7776000 (90 days)`);
  }
  return sec;
}

/** The smallest kosa8 size that covers the requested CPU and memory. */
export function kosa8Size(resources: ProvisionRequest["resources"]): string | undefined {
  if (!resources?.cpu && !resources?.memoryMb) return undefined;
  const size = SIZES.find(
    (s) => s.vcpu >= (resources.cpu ?? 0) && s.memoryMb >= (resources.memoryMb ?? 0),
  );
  if (!size) {
    throw new Error(
      `kosa8 sandboxes have at most 16 vCPU and 32768 MiB; requested ${resources.cpu ?? "-"} vCPU and ${resources.memoryMb ?? "-"} MiB`,
    );
  }
  return size.size;
}

async function isNotFound(err: unknown): Promise<boolean> {
  const { Kosa8NotFoundError } = await import("@kosa8/sdk");
  return err instanceof Kosa8NotFoundError;
}

async function withRedactedErrors<T>(
  target: RuntimeTargetConfig,
  run: () => Promise<T>,
  env: Record<string, string> = {},
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new Error(
      redactWithEnv(String(err), { ...env, KOSA8_API_KEY: target.KOSA8_API_KEY ?? "" }),
    );
  }
}

function sandboxStatus(state: CloudSandboxInfo["state"]): RuntimeStatus {
  switch (state) {
    case "creating":
      return "starting";
    case "running":
      return "running";
    case "paused":
    case "sleeping":
      return "paused";
    case "stopped":
    case "deleted":
    case "host_removed":
      return "exited";
    case "error":
    case "host_lost":
      return "failed";
    default:
      return "unknown";
  }
}

function toHandle(info: CloudSandboxInfo): RuntimeHandle {
  return {
    kind: "kosa8",
    externalId: info.id,
    ...(info.created_at ? { createdAt: new Date(info.created_at).toISOString() } : {}),
    meta: info.labels ?? {},
  };
}

export class Kosa8RuntimeProvider implements RuntimeProvider {
  readonly kind = "kosa8" as const;
  readonly traits = { canProvision: true, ephemeralDisk: true, supportsPause: true };

  checkConfig(target: RuntimeTargetConfig): ConfigStatus {
    const missing = target.KOSA8_API_KEY ? [] : ["KOSA8_API_KEY"];
    const workerUrl = resolveWorkerApiUrl(target);
    try {
      if (!workerUrl || new URL(workerUrl).protocol !== "https:") missing.push("WORKER_API_URL");
    } catch {
      missing.push("WORKER_API_URL");
    }
    if (missing.length)
      return {
        ready: false,
        missing,
        hint: `kosa8 requires ${missing.join(" and ")}. WORKER_API_URL must use HTTPS.`,
      };
    try {
      for (const key of SECONDS_KEYS) seconds(target, key);
    } catch (err) {
      return { ready: false, missing: [], hint: (err as Error).message };
    }
    return { ready: true, missing: [] };
  }

  async provision(target: RuntimeTargetConfig, req: ProvisionRequest): Promise<RuntimeHandle> {
    return withRedactedErrors(
      target,
      async () => {
        if (Object.keys(req.env).length > MAX_ENV) {
          throw new Error(
            `kosa8 sandboxes take at most ${MAX_ENV} env vars; the worker env has ${Object.keys(req.env).length}`,
          );
        }
        const cloud = await client(target);
        const labels = {
          ...req.labels,
          [RUNTIME_LABELS.owner]: req.ownerId,
          [RUNTIME_LABELS.runtimeId]: req.runtimeId,
          [RUNTIME_LABELS.poolId]: req.poolId,
          [RUNTIME_LABELS.agentId]: req.agentId,
        };
        const ttlS = seconds(target, "KOSA8_DELETE_AFTER_SEC");
        const startTimeoutSec =
          seconds(target, "KOSA8_START_TIMEOUT_SEC") ?? DEFAULT_START_TIMEOUT_SEC;
        const common = {
          name: `swarm-rt-${req.runtimeId}`,
          // Values stay on the sandbox's host: never logged or returned by the API.
          env: req.env,
          // An idle worker still has to receive work; never sleep it.
          sleepAfterS: 0,
          ...(ttlS === undefined ? {} : { ttlS }),
          // Label before the cold boot, so list() finds the sandbox while it boots.
          wait: false,
        };
        // A snapshot brings its own image, size and region.
        const size = target.KOSA8_SNAPSHOT ? undefined : kosa8Size(req.resources);
        const sandbox = target.KOSA8_SNAPSHOT
          ? await cloud.sandboxes.create({ ...common, snapshot: target.KOSA8_SNAPSHOT })
          : await cloud.sandboxes.create({
              ...common,
              image: req.image,
              ...(size ? { size } : {}),
              ...(target.KOSA8_REGION ? { region: target.KOSA8_REGION } : {}),
            });
        try {
          await sandbox.setLabels(labels);
          await sandbox.waitUntilRunning({ timeoutMs: startTimeoutSec * 1000 });
          // The env is the sandbox's own, so the command line carries no values.
          const worker = await sandbox.execBackground([
            "sh",
            "-c",
            `cd /workspace && exec ${WORKER_ENTRYPOINT} > ${WORKER_LOG} 2>&1`,
          ]);
          // status() reads the worker's exit through this label, also for listed handles.
          await sandbox.setLabels({ ...labels, [KOSA8_WORKER_EXEC_LABEL]: worker.id });
        } catch (err) {
          await sandbox.delete().catch(() => {});
          throw err;
        }
        return toHandle(sandbox.info);
      },
      req.env,
    );
  }

  async terminate(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    return withRedactedErrors(target, async () => {
      const cloud = await client(target);
      let sandbox: CloudSandbox;
      try {
        sandbox = await cloud.sandboxes.get(handle.externalId);
        if (sandboxStatus(sandbox.info.state) === "exited") return;
        await sandbox.delete();
      } catch (err) {
        if (await isNotFound(err)) return;
        throw err;
      }
      // Only a lookup that no longer finds the sandbox, or finds it deleted,
      // confirms the delete; anything else fails, so the supervisor retries a
      // terminate that is safe to repeat.
      const timeoutSec =
        seconds(target, "KOSA8_TEARDOWN_TIMEOUT_SEC") ?? DEFAULT_TEARDOWN_TIMEOUT_SEC;
      const deadline = Date.now() + timeoutSec * 1000;
      while (true) {
        try {
          await sandbox.refresh();
          if (sandboxStatus(sandbox.info.state) === "exited") return;
        } catch (err) {
          if (await isNotFound(err)) return;
          throw err;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `kosa8 still reports sandbox ${handle.externalId} ${sandbox.info.state} ${timeoutSec}s after deleting it`,
          );
        }
        await Bun.sleep(TEARDOWN_POLL_MS);
      }
    });
  }

  async status(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<RuntimeStatus> {
    return withRedactedErrors(target, async () => {
      const cloud = await client(target);
      let sandbox: CloudSandbox;
      try {
        sandbox = await cloud.sandboxes.get(handle.externalId);
      } catch (err) {
        if (await isNotFound(err)) return "exited";
        throw err;
      }
      const status = sandboxStatus(sandbox.info.state);
      if (status !== "running") return status;
      // A running sandbox can still hold a finished worker: report the worker.
      // Read it only while running: reading a sleeping sandbox's command wakes it.
      const execId =
        sandbox.info.labels?.[KOSA8_WORKER_EXEC_LABEL] ?? handle.meta?.[KOSA8_WORKER_EXEC_LABEL];
      if (!execId) return "starting";
      try {
        const worker = await sandbox.getExec(execId);
        if (worker.info.state === "running") return "running";
        if (worker.info.state === "exited") return worker.info.exit === 0 ? "exited" : "failed";
        return "unknown";
      } catch (err) {
        // A sandbox deleted a moment ago can still read as running.
        return (await isNotFound(err)) ? "exited" : "unknown";
      }
    });
  }

  async list(target: RuntimeTargetConfig, ownerId: string): Promise<RuntimeHandle[]> {
    return withRedactedErrors(target, async () => {
      const cloud = await client(target);
      const handles: RuntimeHandle[] = [];
      for await (const sandbox of cloud.sandboxes.iterate({
        labels: { [RUNTIME_LABELS.runtimeId]: true, [RUNTIME_LABELS.owner]: ownerId },
      })) {
        const labels = sandbox.info.labels ?? {};
        if (!labels[RUNTIME_LABELS.runtimeId] || labels[RUNTIME_LABELS.owner] !== ownerId) continue;
        if (sandboxStatus(sandbox.info.state) === "exited") continue;
        handles.push(toHandle(sandbox.info));
      }
      return handles;
    });
  }

  async pause(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    return withRedactedErrors(target, async () => {
      // Sleep keeps memory and processes; wake resumes the worker where it was.
      await (await (await client(target)).sandboxes.get(handle.externalId)).sleep();
    });
  }

  async resume(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    return withRedactedErrors(target, async () => {
      const sandbox = await (await client(target)).sandboxes.get(handle.externalId);
      if (sandbox.info.state === "sleeping" || sandbox.info.state === "paused")
        await sandbox.wake();
    });
  }
}
