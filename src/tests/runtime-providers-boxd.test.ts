import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { BoxdRuntimeProvider } from "../runtime-providers/boxd";
import { type ProvisionRequest, RUNTIME_LABELS } from "../runtime-providers/types";

// Restore exports explicitly. mock.restore() does not remove module replacements.
const sdk = { ...(await import("@boxd-sh/sdk")) };
const createdAt = new Date("2026-10-23T08:00:00.000Z");
const machine = { id: "vm-1", name: "swarm-rt-1", status: "running", createdAt, labels: {} };
const ok = { stdout: "", stderr: "", exitCode: 0, success: true };
const machines = {
  create: mock(async (params: Record<string, unknown>) => ({
    ...machine,
    labels: params.labels as Record<string, string>,
  })),
  setAutoHibernateTimeout: mock(async (_id: string, _seconds: number) => {}),
  setDeleteAfter: mock(async (_id: string, _seconds: number): Promise<Date | null> => null),
  waitUntilReady: mock(async (_id: string) => {}),
  exec: mock(async (_id: string, _params: Record<string, unknown>) => ok),
  get: mock(async (_id: string): Promise<Record<string, unknown>> => machine),
  list: mock(async (_params: Record<string, unknown>): Promise<Record<string, unknown>[]> => []),
  delete: mock(async (_id: string) => {}),
  pause: mock(async (_id: string) => ({ suspendUs: 1 })),
  resume: mock(async (_id: string) => ({ resumeUs: 1 })),
  wake: mock(async (_id: string) => {}),
};
const clientOptions = mock((_options: Record<string, unknown>) => {});
class FakeBoxd {
  readonly machines = machines;
  constructor(options: Record<string, unknown>) {
    clientOptions(options);
  }
}
const target = {
  BOXD_API_KEY: `bxd_${crypto.randomUUID()}`,
  WORKER_API_URL: "https://swarm.test",
};
const handle = { kind: "boxd" as const, externalId: machine.id };
const request: ProvisionRequest = {
  runtimeId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  poolId: "pool-1",
  ownerId: "owner-1",
  image: "ghcr.io/desplega-ai/agent-swarm-worker:slim",
  env: { AGENT_ROLE: "worker", API_KEY: `token-${crypto.randomUUID()}`, MULTI: "a\nb" },
  labels: { [RUNTIME_LABELS.owner]: "spoofed-owner" },
};
const ownerLabels = {
  [RUNTIME_LABELS.owner]: request.ownerId,
  [RUNTIME_LABELS.runtimeId]: request.runtimeId,
  [RUNTIME_LABELS.poolId]: request.poolId,
  [RUNTIME_LABELS.agentId]: request.agentId,
};
const inspect =
  (stdout: string, exitCode = 0, stderr = "") =>
  async () => ({
    stdout,
    stderr,
    exitCode,
    success: exitCode === 0,
  });

beforeAll(() => {
  mock.module("@boxd-sh/sdk", () => ({ ...sdk, Boxd: FakeBoxd }));
});

afterAll(() => {
  mock.module("@boxd-sh/sdk", () => sdk);
  mock.restore();
});

beforeEach(() => {
  for (const fn of [...Object.values(machines), clientOptions]) fn.mockClear();
  machines.create.mockImplementation(async (params) => ({
    ...machine,
    labels: params.labels as Record<string, string>,
  }));
  machines.setDeleteAfter.mockImplementation(async () => null);
  machines.exec.mockImplementation(async () => ok);
  machines.get.mockImplementation(async () => machine);
  machines.list.mockImplementation(async () => []);
  machines.delete.mockImplementation(async () => {});
});

describe("boxd runtime provider", () => {
  test("requires a key, an HTTPS worker URL, and valid durations", () => {
    const provider = new BoxdRuntimeProvider();
    expect(provider.checkConfig({ WORKER_API_URL: "https://swarm.test" })).toEqual({
      ready: false,
      missing: ["BOXD_API_KEY"],
      hint: "boxd requires BOXD_API_KEY. WORKER_API_URL must use HTTPS.",
    });
    expect(provider.checkConfig({ ...target, WORKER_API_URL: "http://swarm.test" }).ready).toBe(
      false,
    );
    expect(provider.checkConfig(target)).toEqual({ ready: true, missing: [] });
    for (const key of [
      "BOXD_DELETE_AFTER_SEC",
      "BOXD_START_TIMEOUT_SEC",
      "BOXD_STATUS_TIMEOUT_SEC",
      "BOXD_TEARDOWN_TIMEOUT_SEC",
    ]) {
      for (const value of ["soon", "0", "1.5"]) {
        expect(provider.checkConfig({ ...target, [key]: value })).toEqual({
          ready: false,
          missing: [],
          hint: `${key} must be a positive integer`,
        });
      }
      expect(provider.checkConfig({ ...target, [key]: "60" }).ready).toBe(true);
    }
  });

  test("provisions an isolated, labeled machine and passes worker env out of argv", async () => {
    expect(await new BoxdRuntimeProvider().provision(target, request)).toEqual({
      ...handle,
      createdAt: createdAt.toISOString(),
      meta: ownerLabels,
    });
    expect(machines.create).toHaveBeenCalledWith({
      name: `swarm-rt-${request.runtimeId}`,
      org: undefined,
      labels: ownerLabels,
      isolated: true,
      config: { autoSuspendTimeout: 0, idleIgnoreOutbound: false },
    });
    expect(machines.setDeleteAfter).not.toHaveBeenCalled();
    expect(machines.setAutoHibernateTimeout).toHaveBeenCalledWith(machine.id, 0);
    expect(machines.waitUntilReady).toHaveBeenCalledWith(machine.id);
    const [, exec] = machines.exec.mock.calls[0]!;
    expect(exec.command).toEqual([
      "docker",
      "run",
      "-d",
      "--name",
      "swarm-worker",
      "-e",
      "AGENT_ROLE",
      "-e",
      "API_KEY",
      "-e",
      "MULTI",
      request.image,
    ]);
    expect(exec.env).toEqual(request.env);
    expect(exec.timeout).toBe(600_000);
    expect(JSON.stringify(exec.command)).not.toContain(request.env.API_KEY);
  });

  test("maps pool resources to the smallest boxd size and rejects larger requests", async () => {
    const provider = new BoxdRuntimeProvider();
    for (const [resources, size] of [
      [{ cpu: 1 }, { vcpu: 1, memory: "4G" }],
      [{ cpu: 3 }, { vcpu: 4, memory: "16G" }],
      [{ memoryMb: 9000 }, { vcpu: 4, memory: "16G" }],
      [
        { cpu: 2, memoryMb: 8192 },
        { vcpu: 2, memory: "8G" },
      ],
    ] as const) {
      machines.create.mockClear();
      await provider.provision(target, { ...request, resources });
      expect(machines.create.mock.calls[0]?.[0].config).toEqual({
        autoSuspendTimeout: 0,
        idleIgnoreOutbound: false,
        ...size,
      });
    }
    machines.create.mockClear();
    await expect(
      provider.provision(target, { ...request, resources: { cpu: 16 } }),
    ).rejects.toThrow("at most 8 vCPU and 32768 MiB");
    expect(machines.create).not.toHaveBeenCalled();
  });

  test("restores the configured snapshot and applies the org, deadline and start timeout", async () => {
    await new BoxdRuntimeProvider().provision(
      {
        ...target,
        BOXD_SNAPSHOT: "swarm-worker",
        BOXD_ORG: "acme",
        BOXD_DELETE_AFTER_SEC: "3600",
        BOXD_START_TIMEOUT_SEC: "900",
      },
      { ...request, resources: { cpu: 4 } },
    );
    expect(machines.create).toHaveBeenCalledWith({
      name: `swarm-rt-${request.runtimeId}`,
      org: "acme",
      labels: ownerLabels,
      isolated: true,
      fromSnapshot: "swarm-worker",
      config: { autoSuspendTimeout: 0, idleIgnoreOutbound: false },
    });
    expect(machines.setDeleteAfter).toHaveBeenCalledWith(machine.id, 3600);
    expect(machines.exec.mock.calls[0]?.[1].timeout).toBe(900_000);
  });

  test("deletes the machine when its delete deadline cannot be set", async () => {
    machines.setDeleteAfter.mockImplementation(async () => {
      throw new sdk.APIConnectionError("connection reset");
    });
    await expect(
      new BoxdRuntimeProvider().provision({ ...target, BOXD_DELETE_AFTER_SEC: "3600" }, request),
    ).rejects.toThrow("connection reset");
    expect(machines.delete).toHaveBeenCalledWith(machine.id);
    expect(machines.exec).not.toHaveBeenCalled();
  });

  test("deletes the machine when the worker fails to start and keeps that error", async () => {
    const provider = new BoxdRuntimeProvider();
    for (const cleanupFails of [false, true]) {
      machines.delete.mockClear();
      machines.delete.mockImplementation(async () => {
        if (cleanupFails) throw new Error("cleanup failed");
      });
      machines.exec.mockImplementation(inspect("", 125, "pull access denied"));
      await expect(provider.provision(target, request)).rejects.toThrow(
        "failed (exit 125): pull access denied",
      );
      expect(machines.delete).toHaveBeenCalledWith(machine.id);
    }
    machines.delete.mockClear();
    machines.exec.mockImplementation(async () => {
      throw new Error("exec stream reset");
    });
    await expect(provider.provision(target, request)).rejects.toThrow("exec stream reset");
    expect(machines.delete).toHaveBeenCalledWith(machine.id);
  });

  test("status reports the machine, then the worker container on a running machine", async () => {
    const provider = new BoxdRuntimeProvider();
    machines.get.mockImplementation(async () => {
      throw new sdk.NotFoundError("machine not found");
    });
    expect(await provider.status(target, handle)).toBe("exited");
    for (const [status, expected] of [
      ["starting", "starting"],
      ["suspended", "paused"],
      ["hibernated", "paused"],
      ["stopped", "exited"],
      ["failed", "failed"],
    ] as const) {
      machines.get.mockImplementation(async () => ({ ...machine, status }));
      expect(await provider.status(target, handle)).toBe(expected);
    }
    expect(machines.exec).not.toHaveBeenCalled();
    machines.get.mockImplementation(async () => machine);
    machines.exec.mockImplementation(inspect("running 0\n"));
    await provider.status({ ...target, BOXD_STATUS_TIMEOUT_SEC: "5" }, handle);
    expect(machines.exec.mock.calls.map(([, params]) => params.timeout)).toEqual([5_000]);
    for (const [exec, expected] of [
      [inspect("running 0\n"), "running"],
      [inspect("created 0\n"), "starting"],
      [inspect("exited 0\n"), "exited"],
      [inspect("exited 137\n"), "failed"],
      [inspect("", 1, "Error: No such object: swarm-worker"), "exited"],
      [inspect("", 1, "Cannot connect to the Docker daemon"), "unknown"],
    ] as const) {
      machines.exec.mockImplementation(exec);
      expect(await provider.status(target, handle)).toBe(expected);
    }
    machines.exec.mockImplementation(async () => {
      throw new sdk.ConflictError("machine is stopped");
    });
    expect(await provider.status(target, handle)).toBe("unknown");
    // Just after delete, get can still answer "running" while exec finds no VM.
    machines.exec.mockImplementation(async () => {
      throw new sdk.NotFoundError("VM not found");
    });
    expect(await provider.status(target, handle)).toBe("exited");
  });

  test("status preserves machine lookup failures with the key redacted", async () => {
    machines.get.mockImplementation(async () => {
      throw new sdk.AuthenticationError(`rejected ${target.BOXD_API_KEY}`);
    });
    await expect(new BoxdRuntimeProvider().status(target, handle)).rejects.toThrow(
      "rejected [REDACTED",
    );
  });

  test("lists only machines with this owner's runtime labels", async () => {
    const labels = {
      [RUNTIME_LABELS.runtimeId]: request.runtimeId,
      [RUNTIME_LABELS.owner]: request.ownerId,
    };
    machines.list.mockImplementation(async () => [
      { ...machine, labels },
      { ...machine, id: "other-owner", labels: { ...labels, [RUNTIME_LABELS.owner]: "other" } },
      { ...machine, id: "unlabeled", labels: { [RUNTIME_LABELS.owner]: request.ownerId } },
    ]);
    expect(
      await new BoxdRuntimeProvider().list({ ...target, BOXD_ORG: "acme" }, request.ownerId),
    ).toEqual([{ ...handle, createdAt: createdAt.toISOString(), meta: labels }]);
    expect(machines.list).toHaveBeenCalledWith({
      org: "acme",
      labels: [RUNTIME_LABELS.runtimeId, `${RUNTIME_LABELS.owner}=${request.ownerId}`],
    });
  });

  test("terminate deletes by id, waits for teardown, and treats a missing machine as done", async () => {
    const provider = new BoxdRuntimeProvider();
    let reads = 0;
    machines.get.mockImplementation(async () => {
      if (++reads > 1) throw new sdk.NotFoundError("VM not found");
      return machine;
    });
    await provider.terminate(target, handle);
    expect(machines.delete).toHaveBeenCalledWith(handle.externalId);
    expect(reads).toBe(2);
    machines.delete.mockImplementation(async () => {
      throw new sdk.NotFoundError("machine not found");
    });
    await provider.terminate(target, handle);
    machines.delete.mockImplementation(async () => {
      throw new Error(`denied ${target.BOXD_API_KEY}`);
    });
    await expect(provider.terminate(target, handle)).rejects.toThrow("denied [REDACTED");
  });

  test("terminate fails unless boxd confirms the machine is gone", async () => {
    const provider = new BoxdRuntimeProvider();
    machines.get.mockImplementation(async () => {
      throw new sdk.APIConnectionError(`unreachable ${target.BOXD_API_KEY}`);
    });
    await expect(provider.terminate(target, handle)).rejects.toThrow("unreachable [REDACTED");
    machines.get.mockImplementation(async () => machine);
    const started = Date.now();
    await expect(
      provider.terminate({ ...target, BOXD_TEARDOWN_TIMEOUT_SEC: "1" }, handle),
    ).rejects.toThrow(`boxd still reports machine ${machine.id} 1s after deleting it`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });

  test("resume wakes hibernated machines and thaws suspended ones", async () => {
    const provider = new BoxdRuntimeProvider();
    await provider.pause(target, handle);
    expect(machines.pause).toHaveBeenCalledWith(handle.externalId);
    for (const status of ["hibernated", "suspended", "running"]) {
      machines.get.mockImplementation(async () => ({ ...machine, status }));
      await provider.resume(target, handle);
    }
    expect(machines.wake.mock.calls).toEqual([[handle.externalId]]);
    expect(machines.resume.mock.calls).toEqual([[handle.externalId]]);
  });

  test("reuses one client per credential", async () => {
    const provider = new BoxdRuntimeProvider();
    const first = { ...target, BOXD_API_KEY: `bxd_${crypto.randomUUID()}` };
    const second = { ...first, BOXD_API_KEY: `bxd_${crypto.randomUUID()}` };
    await provider.status(first, handle);
    await provider.list(first, request.ownerId);
    await provider.pause(first, handle);
    expect(clientOptions.mock.calls).toEqual([
      [{ apiKey: first.BOXD_API_KEY, baseURL: undefined }],
    ]);
    await provider.status(second, handle);
    expect(clientOptions).toHaveBeenCalledTimes(2);
  });

  test("provision errors redact controller and worker credentials", async () => {
    machines.create.mockImplementation(async () => {
      throw new Error(`Bad credentials ${target.BOXD_API_KEY} ${request.env.API_KEY}`);
    });
    try {
      await new BoxdRuntimeProvider().provision(target, request);
      throw new Error("Provision unexpectedly succeeded");
    } catch (err) {
      expect(String(err)).not.toContain(target.BOXD_API_KEY);
      expect(String(err)).not.toContain(request.env.API_KEY);
      expect(String(err)).toContain("REDACTED");
    }
  });
});
