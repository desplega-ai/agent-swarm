import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { KOSA8_WORKER_EXEC_LABEL, Kosa8RuntimeProvider } from "../runtime-providers/kosa8";
import { type ProvisionRequest, RUNTIME_LABELS } from "../runtime-providers/types";

// Restore exports explicitly. mock.restore() does not remove module replacements.
const sdk = { ...(await import("@kosa8/sdk")) };
const createdAt = Date.parse("2026-11-16T08:00:00.000Z");
const info = {
  id: "sbx_1",
  name: "swarm-rt-1",
  state: "running",
  template: "image-2x4",
  created_at: createdAt,
  labels: {} as Record<string, string>,
};
const notFound = (what = "sandbox") =>
  new sdk.Kosa8NotFoundError(`${what} not found`, { status: 404, code: "not_found" });

/** One fake sandbox: the calls a provider makes on it, recorded in order. */
const calls: string[] = [];
const box = {
  info: { ...info },
  setLabels: mock(async (labels: Record<string, string>) => {
    calls.push("setLabels");
    box.info = { ...box.info, labels };
    return labels;
  }),
  waitUntilRunning: mock(async (_opts?: { timeoutMs?: number }) => {
    calls.push("waitUntilRunning");
    return box;
  }),
  execBackground: mock(async (_cmd: string[]) => {
    calls.push("execBackground");
    return { id: "bg_worker" };
  }),
  getExec: mock(
    async (_id: string): Promise<{ info: { state: string; exit: number | null } }> => ({
      info: { state: "running", exit: null },
    }),
  ),
  delete: mock(async () => {
    calls.push("delete");
  }),
  refresh: mock(async () => box),
  sleep: mock(async () => box),
  wake: mock(async () => box),
};
const sandboxes = {
  create: mock(async (_opts: Record<string, unknown>) => {
    calls.push("create");
    box.info = { ...info, state: "creating", labels: {} };
    return box;
  }),
  get: mock(async (_id: string) => box),
  iterate: mock(async function* (_opts: Record<string, unknown>) {
    yield* listed;
  }),
};
let listed: { info: typeof info }[] = [];
const clientOptions = mock((_options: Record<string, unknown>) => {});
class FakeKosa8Cloud {
  readonly sandboxes = sandboxes;
  constructor(options: Record<string, unknown>) {
    clientOptions(options);
  }
}
const target = {
  KOSA8_API_KEY: `k8c_live_${crypto.randomUUID()}`,
  WORKER_API_URL: "https://swarm.test",
};
const handle = { kind: "kosa8" as const, externalId: info.id };
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
const workerLabels = { ...ownerLabels, [KOSA8_WORKER_EXEC_LABEL]: "bg_worker" };

beforeAll(() => {
  mock.module("@kosa8/sdk", () => ({ ...sdk, Kosa8Cloud: FakeKosa8Cloud }));
});

afterAll(() => {
  mock.module("@kosa8/sdk", () => sdk);
  mock.restore();
});

beforeEach(() => {
  calls.length = 0;
  listed = [];
  box.info = { ...info };
  for (const fn of [...Object.values(sandboxes), clientOptions]) fn.mockClear();
  for (const fn of Object.values(box)) if (typeof fn === "function") fn.mockClear();
  sandboxes.create.mockImplementation(async () => {
    calls.push("create");
    box.info = { ...info, state: "creating", labels: {} };
    return box;
  });
  sandboxes.get.mockImplementation(async () => box);
  box.waitUntilRunning.mockImplementation(async () => {
    calls.push("waitUntilRunning");
    box.info = { ...box.info, state: "running" };
    return box;
  });
  box.execBackground.mockImplementation(async () => {
    calls.push("execBackground");
    return { id: "bg_worker" };
  });
  box.getExec.mockImplementation(async () => ({ info: { state: "running", exit: null } }));
  box.delete.mockImplementation(async () => {
    calls.push("delete");
  });
  box.refresh.mockImplementation(async () => box);
});

describe("kosa8 runtime provider", () => {
  test("requires a key, an HTTPS worker URL, and valid durations", () => {
    const provider = new Kosa8RuntimeProvider();
    expect(provider.checkConfig({ WORKER_API_URL: "https://swarm.test" })).toEqual({
      ready: false,
      missing: ["KOSA8_API_KEY"],
      hint: "kosa8 requires KOSA8_API_KEY. WORKER_API_URL must use HTTPS.",
    });
    expect(provider.checkConfig({ ...target, WORKER_API_URL: "http://swarm.test" }).ready).toBe(
      false,
    );
    expect(provider.checkConfig(target)).toEqual({ ready: true, missing: [] });
    for (const key of [
      "KOSA8_DELETE_AFTER_SEC",
      "KOSA8_START_TIMEOUT_SEC",
      "KOSA8_TEARDOWN_TIMEOUT_SEC",
    ]) {
      for (const value of ["soon", "0", "1.5"]) {
        expect(provider.checkConfig({ ...target, [key]: value })).toEqual({
          ready: false,
          missing: [],
          hint: `${key} must be a positive integer`,
        });
      }
      expect(provider.checkConfig({ ...target, [key]: "3600" }).ready).toBe(true);
    }
    expect(provider.checkConfig({ ...target, KOSA8_DELETE_AFTER_SEC: "30" }).hint).toBe(
      "KOSA8_DELETE_AFTER_SEC must be between 60 and 7776000 (90 days)",
    );
  });

  test("boots the worker image as a labeled sandbox and keeps worker env off the command line", async () => {
    expect(await new Kosa8RuntimeProvider().provision(target, request)).toEqual({
      ...handle,
      createdAt: new Date(createdAt).toISOString(),
      meta: workerLabels,
    });
    expect(sandboxes.create).toHaveBeenCalledWith({
      name: `swarm-rt-${request.runtimeId}`,
      env: request.env,
      sleepAfterS: 0,
      wait: false,
      image: request.image,
    });
    // Labeled before the cold boot, so list() finds a sandbox that is still booting.
    expect(calls).toEqual([
      "create",
      "setLabels",
      "waitUntilRunning",
      "execBackground",
      "setLabels",
    ]);
    expect(box.setLabels.mock.calls).toEqual([[ownerLabels], [workerLabels]]);
    expect(box.waitUntilRunning).toHaveBeenCalledWith({ timeoutMs: 600_000 });
    const [command] = box.execBackground.mock.calls[0]!;
    expect(command).toEqual([
      "sh",
      "-c",
      "cd /workspace && exec /docker-entrypoint.sh > /workspace/.swarm-worker.log 2>&1",
    ]);
    expect(JSON.stringify(command)).not.toContain(request.env.API_KEY);
  });

  test("maps pool resources to the smallest kosa8 size and rejects larger requests", async () => {
    const provider = new Kosa8RuntimeProvider();
    for (const [resources, size] of [
      [{ cpu: 1 }, "2x4"],
      [{ cpu: 3 }, "4x8"],
      [{ memoryMb: 9000 }, "8x16"],
      [{ cpu: 2, memoryMb: 8192 }, "4x8"],
      [{ cpu: 16, memoryMb: 32768 }, "16x32"],
    ] as const) {
      sandboxes.create.mockClear();
      await provider.provision(target, { ...request, resources });
      expect(sandboxes.create.mock.calls[0]?.[0].size).toBe(size);
    }
    sandboxes.create.mockClear();
    await expect(
      provider.provision(target, { ...request, resources: { cpu: 32 } }),
    ).rejects.toThrow("at most 16 vCPU and 32768 MiB");
    expect(sandboxes.create).not.toHaveBeenCalled();
  });

  test("rejects a worker env larger than kosa8 keeps before creating anything", async () => {
    const env = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`VAR_${i}`, "x"]));
    await expect(new Kosa8RuntimeProvider().provision(target, { ...request, env })).rejects.toThrow(
      "at most 64 env vars",
    );
    expect(sandboxes.create).not.toHaveBeenCalled();
  });

  test("starts from the configured snapshot and applies the region, lifetime and start timeout", async () => {
    const provider = new Kosa8RuntimeProvider();
    await provider.provision(
      {
        ...target,
        KOSA8_SNAPSHOT: "snap_worker123",
        KOSA8_REGION: "eu-hel1",
        KOSA8_DELETE_AFTER_SEC: "3600",
        KOSA8_START_TIMEOUT_SEC: "900",
      },
      { ...request, resources: { cpu: 4 } },
    );
    expect(sandboxes.create).toHaveBeenCalledWith({
      name: `swarm-rt-${request.runtimeId}`,
      env: request.env,
      sleepAfterS: 0,
      ttlS: 3600,
      wait: false,
      snapshot: "snap_worker123",
    });
    expect(box.waitUntilRunning).toHaveBeenCalledWith({ timeoutMs: 900_000 });
    sandboxes.create.mockClear();
    await provider.provision({ ...target, KOSA8_REGION: "eu-hel1" }, request);
    expect(sandboxes.create.mock.calls[0]?.[0].region).toBe("eu-hel1");
  });

  test("deletes the sandbox when any step after create fails, and keeps that error", async () => {
    const provider = new Kosa8RuntimeProvider();
    for (const [step, fail] of [
      ["setLabels", box.setLabels],
      ["waitUntilRunning", box.waitUntilRunning],
      ["execBackground", box.execBackground],
    ] as const) {
      calls.length = 0;
      (
        fail as { mockImplementationOnce: (fn: () => Promise<never>) => void }
      ).mockImplementationOnce(async () => {
        throw new Error(`${step} broke`);
      });
      await expect(provider.provision(target, request)).rejects.toThrow(`${step} broke`);
      expect(calls.at(-1)).toBe("delete");
    }
    box.delete.mockImplementation(async () => {
      throw new Error("cleanup failed");
    });
    box.execBackground.mockImplementationOnce(async () => {
      throw new Error("exec refused");
    });
    await expect(provider.provision(target, request)).rejects.toThrow("exec refused");
  });

  test("status reports the sandbox, then the worker command on a running sandbox", async () => {
    const provider = new Kosa8RuntimeProvider();
    sandboxes.get.mockImplementation(async () => {
      throw notFound();
    });
    expect(await provider.status(target, handle)).toBe("exited");
    sandboxes.get.mockImplementation(async () => box);
    for (const [state, expected] of [
      ["creating", "starting"],
      ["sleeping", "paused"],
      ["paused", "paused"],
      ["stopped", "exited"],
      ["deleted", "exited"],
      ["host_removed", "exited"],
      ["error", "failed"],
      ["host_lost", "failed"],
      ["something-new", "unknown"],
    ] as const) {
      box.info = { ...info, state, labels: workerLabels };
      expect(await provider.status(target, handle)).toBe(expected);
    }
    // A sleeping sandbox's command is never read: that would wake it.
    expect(box.getExec).not.toHaveBeenCalled();
    box.info = { ...info, labels: ownerLabels };
    expect(await provider.status(target, handle)).toBe("starting");
    box.info = { ...info, labels: workerLabels };
    for (const [worker, expected] of [
      [{ state: "running", exit: null }, "running"],
      [{ state: "exited", exit: 0 }, "exited"],
      [{ state: "exited", exit: 137 }, "failed"],
    ] as const) {
      box.getExec.mockImplementation(async () => ({ info: worker }));
      expect(await provider.status(target, handle)).toBe(expected);
    }
    expect(box.getExec).toHaveBeenLastCalledWith("bg_worker");
    box.getExec.mockImplementation(async () => {
      throw new Error("host unreachable");
    });
    expect(await provider.status(target, handle)).toBe("unknown");
    // Just after delete, get can still answer "running" while the command is gone.
    box.getExec.mockImplementation(async () => {
      throw notFound("exec");
    });
    expect(await provider.status(target, handle)).toBe("exited");
  });

  test("status preserves sandbox lookup failures with the key redacted", async () => {
    sandboxes.get.mockImplementation(async () => {
      throw new Error(`rejected ${target.KOSA8_API_KEY}`);
    });
    await expect(new Kosa8RuntimeProvider().status(target, handle)).rejects.toThrow(
      "rejected [REDACTED",
    );
  });

  test("lists only live sandboxes with this owner's runtime labels", async () => {
    const labels = {
      [RUNTIME_LABELS.runtimeId]: request.runtimeId,
      [RUNTIME_LABELS.owner]: request.ownerId,
    };
    listed = [
      { info: { ...info, labels } },
      { info: { ...info, id: "other-owner", labels: { ...labels, [RUNTIME_LABELS.owner]: "x" } } },
      { info: { ...info, id: "unlabeled", labels: { [RUNTIME_LABELS.owner]: request.ownerId } } },
      { info: { ...info, id: "gone", state: "deleted", labels } },
    ];
    expect(await new Kosa8RuntimeProvider().list(target, request.ownerId)).toEqual([
      { ...handle, createdAt: new Date(createdAt).toISOString(), meta: labels },
    ]);
    expect(sandboxes.iterate).toHaveBeenCalledWith({
      labels: { [RUNTIME_LABELS.runtimeId]: true, [RUNTIME_LABELS.owner]: request.ownerId },
    });
  });

  test("terminate deletes, waits for teardown, and treats a missing sandbox as done", async () => {
    const provider = new Kosa8RuntimeProvider();
    let reads = 0;
    box.refresh.mockImplementation(async () => {
      if (++reads > 1) box.info = { ...box.info, state: "deleted" };
      return box;
    });
    await provider.terminate(target, handle);
    expect(sandboxes.get).toHaveBeenCalledWith(handle.externalId);
    expect(box.delete).toHaveBeenCalledTimes(1);
    expect(reads).toBe(2);
    // Already deleted: nothing to do.
    box.delete.mockClear();
    await provider.terminate(target, handle);
    expect(box.delete).not.toHaveBeenCalled();
    sandboxes.get.mockImplementation(async () => {
      throw notFound();
    });
    await provider.terminate(target, handle);
    sandboxes.get.mockImplementation(async () => {
      throw new Error(`denied ${target.KOSA8_API_KEY}`);
    });
    await expect(provider.terminate(target, handle)).rejects.toThrow("denied [REDACTED");
  });

  test("terminate fails unless kosa8 confirms the sandbox is gone", async () => {
    const provider = new Kosa8RuntimeProvider();
    box.refresh.mockImplementation(async () => {
      throw new Error(`unreachable ${target.KOSA8_API_KEY}`);
    });
    await expect(provider.terminate(target, handle)).rejects.toThrow("unreachable [REDACTED");
    box.info = { ...info };
    box.refresh.mockImplementation(async () => box);
    const started = Date.now();
    await expect(
      provider.terminate({ ...target, KOSA8_TEARDOWN_TIMEOUT_SEC: "1" }, handle),
    ).rejects.toThrow(`kosa8 still reports sandbox ${info.id} running 1s after deleting it`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  });

  test("pause sleeps the sandbox and resume wakes only a sleeping one", async () => {
    const provider = new Kosa8RuntimeProvider();
    await provider.pause(target, handle);
    expect(box.sleep).toHaveBeenCalledTimes(1);
    for (const state of ["sleeping", "paused", "running"]) {
      box.info = { ...info, state };
      await provider.resume(target, handle);
    }
    expect(box.wake).toHaveBeenCalledTimes(2);
  });

  test("reuses one client per credential and reads only the target config", async () => {
    const provider = new Kosa8RuntimeProvider();
    const first = { ...target, KOSA8_API_KEY: `k8c_live_${crypto.randomUUID()}` };
    const second = { ...first, KOSA8_API_KEY: `k8c_live_${crypto.randomUUID()}` };
    await provider.status(first, handle);
    await provider.list(first, request.ownerId);
    await provider.pause(first, handle);
    expect(clientOptions.mock.calls).toEqual([
      [{ apiKey: first.KOSA8_API_KEY, baseUrl: undefined, env: {} }],
    ]);
    await provider.status({ ...second, KOSA8_API_URL: "https://kosa8.internal" }, handle);
    expect(clientOptions.mock.calls[1]).toEqual([
      { apiKey: second.KOSA8_API_KEY, baseUrl: "https://kosa8.internal", env: {} },
    ]);
  });

  test("provision errors redact controller and worker credentials", async () => {
    sandboxes.create.mockImplementation(async () => {
      throw new Error(`Bad credentials ${target.KOSA8_API_KEY} ${request.env.API_KEY}`);
    });
    try {
      await new Kosa8RuntimeProvider().provision(target, request);
      throw new Error("Provision unexpectedly succeeded");
    } catch (err) {
      expect(String(err)).not.toContain(target.KOSA8_API_KEY);
      expect(String(err)).not.toContain(request.env.API_KEY);
      expect(String(err)).toContain("REDACTED");
    }
  });
});
