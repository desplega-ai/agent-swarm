import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { E2BSandboxInfo, TtlRemaining } from "../e2b/dispatch";
import { E2BRuntimeProvider } from "../runtime-providers/e2b";
import { type ProvisionRequest, RUNTIME_LABELS } from "../runtime-providers/types";

// Restore exports explicitly. mock.restore() does not remove module replacements.
const dispatch = { ...(await import("../e2b/dispatch")) };
const sdk = { ...(await import("e2b")) };
const endAt = "2026-10-11T12:15:00.000Z";
const sandbox = { sandboxID: "sandbox-1", templateID: "worker-template" };
const createSandbox = mock(async (_opts: Parameters<typeof dispatch.createSandbox>[0]) => sandbox);
const startDetachedProcess = mock(
  async (_opts: Parameters<typeof dispatch.startDetachedProcess>[0]) => "pid-1",
);
const killSandbox = mock(async (_id: string, _key: string, _base?: string) => {});
const listSandboxes = mock(async (_key: string, _base?: string): Promise<E2BSandboxInfo[]> => []);
const setSandboxTimeout = mock(
  async (_opts: Parameters<typeof dispatch.setSandboxTimeout>[0]): Promise<TtlRemaining> => ({
    expiresAt: endAt,
  }),
);
const getInfo = mock(async (_id: string, _opts?: unknown) => ({ state: "running" }));
const betaPause = mock(async (_id: string, _opts?: unknown) => true);
const connect = mock(async (_id: string, _opts?: unknown) => ({}));
const target = {
  E2B_API_KEY: `controller-${crypto.randomUUID()}`,
  E2B_API_BASE: "https://e2b.test",
};
const handle = { kind: "e2b" as const, externalId: sandbox.sandboxID };
const request: ProvisionRequest = {
  runtimeId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  poolId: "pool-1",
  ownerId: "owner-1",
  image: sandbox.templateID,
  env: { AGENT_ROLE: "worker" },
  labels: { [RUNTIME_LABELS.owner]: "spoofed-owner" },
};

beforeAll(() => {
  mock.module("../e2b/dispatch", () => ({
    ...dispatch,
    createSandbox,
    startDetachedProcess,
    killSandbox,
    listSandboxes,
    setSandboxTimeout,
  }));
  mock.module("e2b", () => ({ ...sdk, Sandbox: { getInfo, betaPause, connect } }));
});

afterAll(() => {
  mock.module("../e2b/dispatch", () => dispatch);
  mock.module("e2b", () => sdk);
  mock.restore();
});

beforeEach(() => {
  for (const fn of [
    createSandbox,
    startDetachedProcess,
    killSandbox,
    listSandboxes,
    setSandboxTimeout,
    getInfo,
    betaPause,
    connect,
  ])
    fn.mockClear();
  createSandbox.mockImplementation(async () => sandbox);
  listSandboxes.mockImplementation(async () => []);
  setSandboxTimeout.mockImplementation(async () => ({ expiresAt: endAt }));
  getInfo.mockImplementation(async () => ({ state: "running" }));
});

describe("E2B runtime provider", () => {
  test("requires a controller key and configures the continuous limit", () => {
    expect(new E2BRuntimeProvider().checkConfig({})).toEqual({
      ready: false,
      missing: ["E2B_API_KEY"],
    });
    expect(new E2BRuntimeProvider().checkConfig(target).ready).toBe(true);
    expect(new E2BRuntimeProvider().traits.maxContinuousSec).toBe(3600);
    expect(
      new E2BRuntimeProvider({ E2B_MAX_CONTINUOUS_SEC: "86400" }).traits.maxContinuousSec,
    ).toBe(86400);
    expect(() => new E2BRuntimeProvider({ E2B_MAX_CONTINUOUS_SEC: "invalid" })).toThrow(
      "positive integer",
    );
  });

  test("provisions with owner metadata and a short default lease", async () => {
    expect(await new E2BRuntimeProvider().provision(target, request)).toEqual(handle);
    expect(createSandbox).toHaveBeenCalledWith({
      apiKey: target.E2B_API_KEY,
      apiBase: target.E2B_API_BASE,
      template: request.image,
      timeoutSec: 900,
      envVars: request.env,
      metadata: {
        [RUNTIME_LABELS.owner]: request.ownerId,
        [RUNTIME_LABELS.runtimeId]: request.runtimeId,
        [RUNTIME_LABELS.agentId]: request.agentId,
        [RUNTIME_LABELS.poolId]: request.poolId,
      },
    });
    expect(startDetachedProcess).toHaveBeenCalledWith({
      sandbox,
      apiKey: target.E2B_API_KEY,
      apiBase: target.E2B_API_BASE,
      env: request.env,
      command: "/docker-entrypoint.sh",
      role: "worker",
      cwd: "/workspace",
    });
    await new E2BRuntimeProvider().provision(target, { ...request, ttlSec: 300 });
    expect(createSandbox.mock.calls[1]?.[0].timeoutSec).toBe(300);
  });

  test("lists only runtimes with both owner and runtime labels", async () => {
    const metadata = {
      [RUNTIME_LABELS.runtimeId]: request.runtimeId,
      [RUNTIME_LABELS.owner]: request.ownerId,
    };
    listSandboxes.mockImplementation(async () => [
      { ...sandbox, metadata },
      {
        ...sandbox,
        sandboxID: "other-owner",
        metadata: { ...metadata, [RUNTIME_LABELS.owner]: "other" },
      },
      {
        ...sandbox,
        sandboxID: "legacy",
        metadata: { [RUNTIME_LABELS.runtimeId]: request.runtimeId },
      },
      { ...sandbox, sandboxID: "unrelated", metadata: { [RUNTIME_LABELS.owner]: request.ownerId } },
    ]);
    expect(await new E2BRuntimeProvider().list(target, request.ownerId)).toEqual([
      { ...handle, meta: metadata },
    ]);
    expect(listSandboxes).toHaveBeenCalledWith(target.E2B_API_KEY, target.E2B_API_BASE);
  });

  test("status uses a single lookup without resuming a paused sandbox", async () => {
    const provider = new E2BRuntimeProvider();
    expect(await provider.status(target, handle)).toBe("running");
    expect(getInfo).toHaveBeenCalledWith(handle.externalId, {
      apiKey: target.E2B_API_KEY,
      apiUrl: target.E2B_API_BASE,
    });
    getInfo.mockImplementation(async () => ({ state: "paused" }));
    expect(await provider.status(target, handle)).toBe("paused");
    expect(getInfo).toHaveBeenCalledTimes(2);
    expect(listSandboxes).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  test("maps missing sandboxes to exited and preserves other lookup errors", async () => {
    getInfo.mockImplementation(async () => {
      throw new sdk.SandboxNotFoundError("missing");
    });
    expect(await new E2BRuntimeProvider().status(target, handle)).toBe("exited");
    getInfo.mockImplementation(async () => {
      throw new Error(`Unauthorized ${target.E2B_API_KEY}`);
    });
    await expect(new E2BRuntimeProvider().status(target, handle)).rejects.toThrow(
      "Unauthorized [REDACTED",
    );
  });

  test("renew returns the authoritative clamped expiry", async () => {
    expect(await new E2BRuntimeProvider().renew(target, handle, 86400)).toEqual({ endAt });
    expect(setSandboxTimeout).toHaveBeenCalledWith({
      sandboxId: handle.externalId,
      apiKey: target.E2B_API_KEY,
      apiBase: target.E2B_API_BASE,
      timeoutMs: 86_400_000,
    });
    setSandboxTimeout.mockImplementation(async () => ({}));
    await expect(new E2BRuntimeProvider().renew(target, handle, 300)).rejects.toThrow(
      "did not return the renewed expiry",
    );
  });

  test("pause and resume use the SDK with target credentials", async () => {
    const provider = new E2BRuntimeProvider();
    await provider.pause(target, handle);
    await provider.resume(target, handle);
    const options = { apiKey: target.E2B_API_KEY, apiUrl: target.E2B_API_BASE };
    expect(betaPause).toHaveBeenCalledWith(handle.externalId, options);
    expect(connect).toHaveBeenCalledWith(handle.externalId, options);
  });

  test("terminate calls the existing kill helper", async () => {
    await new E2BRuntimeProvider().terminate(target, handle);
    expect(killSandbox).toHaveBeenCalledWith(
      handle.externalId,
      target.E2B_API_KEY,
      target.E2B_API_BASE,
    );
  });

  test("provision errors redact worker and controller credentials", async () => {
    const secret = `worker-${crypto.randomUUID()}`;
    createSandbox.mockImplementation(async () => {
      throw new Error(`Bad credentials ${target.E2B_API_KEY} ${secret}`);
    });
    try {
      await new E2BRuntimeProvider().provision(target, { ...request, env: { API_KEY: secret } });
      throw new Error("Provision unexpectedly succeeded");
    } catch (err) {
      expect(String(err)).not.toContain(secret);
      expect(String(err)).not.toContain(target.E2B_API_KEY);
      expect(String(err)).toContain("REDACTED");
    }
  });
});
