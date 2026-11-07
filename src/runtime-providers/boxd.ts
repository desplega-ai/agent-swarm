import type { Boxd, Machine, MachineStatus } from "@boxd-sh/sdk";
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
 * boxd runtime provider. Each runtime is one boxd microVM: create an isolated
 * machine, then run the worker image in the machine's Docker daemon, the same
 * container the docker provider starts on a local host.
 *
 * Target config:
 * - BOXD_API_KEY (required)
 * - BOXD_ORG (optional; an org API key already selects its org)
 * - BOXD_BASE_URL (optional API endpoint)
 * - BOXD_SNAPSHOT (optional snapshot to boot from, e.g. one with the worker image pulled)
 * - BOXD_DELETE_AFTER_SEC (optional wall-clock deadline after which boxd deletes the machine)
 * - BOXD_START_TIMEOUT_SEC (optional, default 600: `docker run`, image pull included)
 * - BOXD_STATUS_TIMEOUT_SEC (optional, default 15: the `docker inspect` behind status)
 * - BOXD_TEARDOWN_TIMEOUT_SEC (optional, default 30: waiting for boxd to confirm a delete)
 * - WORKER_API_URL (required HTTPS URL, with deployment fallbacks)
 */
const WORKER_CONTAINER = "swarm-worker";
const DEFAULT_START_TIMEOUT_SEC = 600;
const DEFAULT_STATUS_TIMEOUT_SEC = 15;
const DEFAULT_TEARDOWN_TIMEOUT_SEC = 30;
const TEARDOWN_POLL_MS = 200;
const SECONDS_KEYS = [
  "BOXD_DELETE_AFTER_SEC",
  "BOXD_START_TIMEOUT_SEC",
  "BOXD_STATUS_TIMEOUT_SEC",
  "BOXD_TEARDOWN_TIMEOUT_SEC",
] as const;

/** boxd size classes, smallest first. */
const SIZES = [
  { vcpu: 1, memoryMb: 4096 },
  { vcpu: 2, memoryMb: 8192 },
  { vcpu: 4, memoryMb: 16384 },
  { vcpu: 8, memoryMb: 32768 },
] as const;

// One client per credential. Each client exchanges its key for a session token
// and refreshes it, and boxd rate-limits that exchange.
const clients = new Map<string, Promise<Boxd>>();

async function client(target: RuntimeTargetConfig): Promise<Boxd> {
  if (!target.BOXD_API_KEY) throw new Error("Missing BOXD_API_KEY");
  const key = `${target.BOXD_BASE_URL ?? ""}\n${target.BOXD_API_KEY}`;
  let boxd = clients.get(key);
  if (!boxd) {
    boxd = import("@boxd-sh/sdk").then(
      ({ Boxd }) => new Boxd({ apiKey: target.BOXD_API_KEY, baseURL: target.BOXD_BASE_URL }),
    );
    clients.set(key, boxd);
  }
  return boxd;
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
  return sec;
}

/** The smallest boxd size that covers the requested CPU and memory. */
function boxdSize(resources: ProvisionRequest["resources"]): {
  vcpu: number;
  memory: string;
} | null {
  if (!resources?.cpu && !resources?.memoryMb) return null;
  const size = SIZES.find(
    (s) => s.vcpu >= (resources.cpu ?? 0) && s.memoryMb >= (resources.memoryMb ?? 0),
  );
  if (!size) {
    throw new Error(
      `boxd machines have at most 8 vCPU and 32768 MiB; requested ${resources.cpu ?? "-"} vCPU and ${resources.memoryMb ?? "-"} MiB`,
    );
  }
  return { vcpu: size.vcpu, memory: `${size.memoryMb / 1024}G` };
}

async function isNotFound(err: unknown): Promise<boolean> {
  const { NotFoundError } = await import("@boxd-sh/sdk");
  return err instanceof NotFoundError;
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
      redactWithEnv(String(err), { ...env, BOXD_API_KEY: target.BOXD_API_KEY ?? "" }),
    );
  }
}

function machineStatus(status: MachineStatus): RuntimeStatus {
  switch (status) {
    case "pending":
    case "starting":
    case "migrating":
      return "starting";
    case "running":
      return "running";
    case "suspended":
    case "hibernated":
      return "paused";
    case "stopped":
    case "destroyed":
      return "exited";
    case "failed":
      return "failed";
    default:
      return "unknown";
  }
}

function toHandle(machine: Machine): RuntimeHandle {
  return {
    kind: "boxd",
    externalId: machine.id,
    ...(machine.createdAt ? { createdAt: machine.createdAt.toISOString() } : {}),
    meta: machine.labels,
  };
}

export class BoxdRuntimeProvider implements RuntimeProvider {
  readonly kind = "boxd" as const;
  readonly traits = { canProvision: true, ephemeralDisk: true, supportsPause: true };

  checkConfig(target: RuntimeTargetConfig): ConfigStatus {
    const missing = target.BOXD_API_KEY ? [] : ["BOXD_API_KEY"];
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
        hint: `boxd requires ${missing.join(" and ")}. WORKER_API_URL must use HTTPS.`,
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
        const boxd = await client(target);
        const labels = {
          ...req.labels,
          [RUNTIME_LABELS.owner]: req.ownerId,
          [RUNTIME_LABELS.runtimeId]: req.runtimeId,
          [RUNTIME_LABELS.poolId]: req.poolId,
          [RUNTIME_LABELS.agentId]: req.agentId,
        };
        const deleteAfter = seconds(target, "BOXD_DELETE_AFTER_SEC");
        const startTimeoutSec =
          seconds(target, "BOXD_START_TIMEOUT_SEC") ?? DEFAULT_START_TIMEOUT_SEC;
        const common = {
          name: `swarm-rt-${req.runtimeId}`,
          org: target.BOXD_ORG || undefined,
          labels,
          // Workers run agent code: no metadata endpoint, integrations, or boxd CLI.
          isolated: true,
        };
        // An idle worker still has to receive work; never suspend it.
        const idle = { autoSuspendTimeout: 0, idleIgnoreOutbound: false };
        const size = boxdSize(req.resources);
        const machine = target.BOXD_SNAPSHOT
          ? await boxd.machines.create({
              ...common,
              fromSnapshot: target.BOXD_SNAPSHOT,
              config: idle,
            })
          : await boxd.machines.create({ ...common, config: { ...idle, ...size } });
        try {
          // Set here rather than through create: the SDK sets the deadline in a
          // second call, and if that call failed, create would reject after the
          // machine exists, leaving it with no deadline and no handle to delete.
          if (deleteAfter !== undefined) {
            await boxd.machines.setDeleteAfter(machine.id, deleteAfter);
          }
          // A hibernated worker cannot be woken by its own outbound traffic.
          await boxd.machines.setAutoHibernateTimeout(machine.id, 0);
          await boxd.machines.waitUntilReady(machine.id);
          // Pass names only on the command line; the values travel as exec env.
          const result = await boxd.machines.exec(machine.id, {
            command: [
              "docker",
              "run",
              "-d",
              "--name",
              WORKER_CONTAINER,
              ...Object.keys(req.env).flatMap((key) => ["-e", key]),
              req.image,
            ],
            env: req.env,
            timeout: startTimeoutSec * 1000,
          });
          if (result.exitCode !== 0) {
            throw new Error(
              `docker run ${req.image} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-2000)}`,
            );
          }
        } catch (err) {
          await boxd.machines.delete(machine.id).catch(() => {});
          throw err;
        }
        return toHandle(machine);
      },
      req.env,
    );
  }

  async terminate(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    return withRedactedErrors(target, async () => {
      const boxd = await client(target);
      try {
        await boxd.machines.delete(handle.externalId);
      } catch (err) {
        if (await isNotFound(err)) return;
        throw err;
      }
      // delete resolves before teardown finishes. Only a lookup that no longer
      // finds the machine confirms it; anything else fails, so the supervisor
      // retries a terminate that is safe to repeat.
      const timeoutSec =
        seconds(target, "BOXD_TEARDOWN_TIMEOUT_SEC") ?? DEFAULT_TEARDOWN_TIMEOUT_SEC;
      const deadline = Date.now() + timeoutSec * 1000;
      while (true) {
        try {
          await boxd.machines.get(handle.externalId);
        } catch (err) {
          if (await isNotFound(err)) return;
          throw err;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `boxd still reports machine ${handle.externalId} ${timeoutSec}s after deleting it`,
          );
        }
        await Bun.sleep(TEARDOWN_POLL_MS);
      }
    });
  }

  async status(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<RuntimeStatus> {
    return withRedactedErrors(target, async () => {
      const boxd = await client(target);
      let machine: Machine;
      try {
        machine = await boxd.machines.get(handle.externalId);
      } catch (err) {
        if (await isNotFound(err)) return "exited";
        throw err;
      }
      const status = machineStatus(machine.status);
      if (status !== "running") return status;
      // A running machine can still hold a finished worker: report the container.
      const timeoutSec = seconds(target, "BOXD_STATUS_TIMEOUT_SEC") ?? DEFAULT_STATUS_TIMEOUT_SEC;
      try {
        const result = await boxd.machines.exec(machine.id, {
          command: [
            "docker",
            "inspect",
            "-f",
            "{{.State.Status}} {{.State.ExitCode}}",
            WORKER_CONTAINER,
          ],
          timeout: timeoutSec * 1000,
        });
        if (result.exitCode !== 0) {
          return /no such (object|container)/i.test(result.stderr) ? "exited" : "unknown";
        }
        const [state, code] = result.stdout.trim().split(" ");
        switch (state) {
          case "created":
            return "starting";
          case "running":
          case "restarting":
          case "paused":
            return "running";
          case "exited":
          case "dead":
            return code === "0" ? "exited" : "failed";
          default:
            return "unknown";
        }
      } catch (err) {
        // A machine deleted a moment ago can still read as running.
        return (await isNotFound(err)) ? "exited" : "unknown";
      }
    });
  }

  async list(target: RuntimeTargetConfig, ownerId: string): Promise<RuntimeHandle[]> {
    return withRedactedErrors(target, async () => {
      const machines = await (await client(target)).machines.list({
        org: target.BOXD_ORG || undefined,
        labels: [RUNTIME_LABELS.runtimeId, `${RUNTIME_LABELS.owner}=${ownerId}`],
      });
      return machines
        .filter(
          (machine) =>
            machine.labels[RUNTIME_LABELS.runtimeId] &&
            machine.labels[RUNTIME_LABELS.owner] === ownerId,
        )
        .map(toHandle);
    });
  }

  async pause(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    return withRedactedErrors(target, async () => {
      await (await client(target)).machines.pause(handle.externalId);
    });
  }

  async resume(target: RuntimeTargetConfig, handle: RuntimeHandle): Promise<void> {
    return withRedactedErrors(target, async () => {
      const boxd = await client(target);
      const { status } = await boxd.machines.get(handle.externalId);
      if (status === "hibernated") await boxd.machines.wake(handle.externalId);
      else if (status === "suspended") await boxd.machines.resume(handle.externalId);
    });
  }
}
