import { describe, expect, test } from "bun:test";
import { AgentFsError } from "../../lib/agent-fs/client";
import type { AgentFsCredential } from "../../lib/agent-fs/credential-store";
import { autoConnect, type ConnectFlowDeps, connectWithKey } from "./connect-flow";

const KEY = "af_test_0123456789abcdef";
const me = {
  userId: "user-1",
  email: "human@example.com",
  displayName: "Human",
  defaultOrgId: null,
  defaultDriveId: null,
};

/** Fakes that succeed. `ls` answers each call from `lsResults` in order ("ok" or a status). */
function fakeDeps(overrides: Partial<ConnectFlowDeps> = {}, lsResults: Array<"ok" | number> = []) {
  const calls = {
    fsMe: 0,
    mint: [] as string[],
    getMe: 0,
    ls: 0,
    invite: [] as string[],
    inviteKeys: [] as string[],
  };
  const connected: AgentFsCredential[] = [];
  const deps: ConnectFlowDeps = {
    fsMe: async () => {
      calls.fsMe++;
      return {
        status: "ready",
        agentFsUserId: "fs-user-1",
        email: "human@example.com",
        displayName: "Human",
        orgId: "org-1",
        driveId: "drive-1",
      };
    },
    mintKey: async (label) => {
      calls.mint.push(label);
      return {
        apiKey: KEY,
        keyId: "key-1",
        label,
        agentFsUserId: "fs-user-1",
        orgId: "org-1",
        driveId: "drive-1",
      };
    },
    getMe: async () => {
      calls.getMe++;
      return me;
    },
    ls: async () => {
      const result = lsResults[calls.ls++] ?? "ok";
      if (result !== "ok") throw new AgentFsError(result, "ERR", `ls failed: ${result}`);
      return { entries: [] };
    },
    invite: async (email, apiKey) => {
      calls.invite.push(email);
      calls.inviteKeys.push(apiKey);
    },
    connect: (credential) => {
      connected.push(credential);
    },
    ...overrides,
  };
  return { deps, calls, connected };
}

describe("connect flow", () => {
  test("an existing member connects without an invite", async () => {
    const { deps, calls, connected } = fakeDeps();
    expect(await connectWithKey(deps, KEY)).toEqual({ kind: "connected" });
    expect(calls.invite).toEqual([]);
    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({
      apiKey: KEY,
      userId: "user-1",
      email: "human@example.com",
      displayName: "Human",
    });
  });

  test("ls-first invites only on 403 or 404", async () => {
    for (const status of [403, 404]) {
      const { deps, calls, connected } = fakeDeps({}, [status, "ok"]);
      expect(await connectWithKey(deps, KEY)).toEqual({ kind: "connected" });
      expect(calls.invite).toEqual(["human@example.com"]);
      // The connecting key accepts a pending invite (agent-fs >= 0.18.19).
      expect(calls.inviteKeys).toEqual([KEY]);
      expect(calls.ls).toBe(2);
      expect(connected).toHaveLength(1);
    }

    const { deps, calls, connected } = fakeDeps({}, [500]);
    const outcome = await connectWithKey(deps, KEY);
    expect(outcome).toEqual({ kind: "failed", message: "ls failed: 500" });
    expect(calls.invite).toEqual([]);
    expect(connected).toHaveLength(0);
  });

  test("a failed invite never calls connect", async () => {
    const { deps, connected } = fakeDeps(
      {
        invite: async () => {
          throw new Error("403 Forbidden");
        },
      },
      [403],
    );
    expect(await connectWithKey(deps, KEY)).toEqual({
      kind: "failed",
      message: "Ask a swarm admin to invite human@example.com to the drive.",
    });
    expect(connected).toHaveLength(0);
  });

  test("an invite that still leaves no access never calls connect", async () => {
    const { deps, calls, connected } = fakeDeps({}, [404, 404]);
    const outcome = await connectWithKey(deps, KEY);
    expect(outcome.kind).toBe("failed");
    expect(calls.invite).toHaveLength(1);
    expect(connected).toHaveLength(0);
  });

  test("a rejected key gives a readable message", async () => {
    const { deps, connected } = fakeDeps({
      getMe: async () => {
        throw new AgentFsError(401, "UNAUTHORIZED", "Invalid API key");
      },
    });
    expect(await connectWithKey(deps, KEY)).toEqual({
      kind: "failed",
      message: "agent-fs does not accept this key.",
    });
    expect(connected).toHaveLength(0);
  });
});

/** A swarm API error as `FsApiError` throws it. */
function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

const LABEL = "Swarm dashboard · Chrome on macOS · 2026-11-04";

describe("autoConnect", () => {
  test("mints a named key and saves the swarm identity, never agent-fs /auth/me", async () => {
    const { deps, calls, connected } = fakeDeps();
    expect(await autoConnect(deps, LABEL)).toEqual({ kind: "connected" });
    expect(calls.mint).toEqual([LABEL]);
    expect(calls.getMe).toBe(0);
    expect(calls.ls).toBe(0);
    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({
      apiKey: KEY,
      userId: "fs-user-1",
      email: "human@example.com",
      displayName: "Human",
      label: LABEL,
      keyId: "key-1",
    });
  });

  test("a pending account shows the server reason and mints nothing", async () => {
    const { deps, calls, connected } = fakeDeps({
      fsMe: async () => ({ status: "pending", email: "h@x.test", reason: "Registration closed" }),
    });
    expect(await autoConnect(deps, LABEL)).toEqual({
      kind: "pending",
      reason: "Registration closed",
    });
    expect(calls.mint).toEqual([]);
    expect(connected).toHaveLength(0);
  });

  test("a 409 from the mint is pending, with the prefix dropped", async () => {
    const { deps, connected } = fakeDeps({
      mintKey: async () => {
        throw apiError(409, "agent-fs account pending: The agent-fs org invite is pending");
      },
    });
    expect(await autoConnect(deps, LABEL)).toEqual({
      kind: "pending",
      reason: "The agent-fs org invite is pending",
    });
    expect(connected).toHaveLength(0);
  });

  test("a 501 (agent-fs too old) falls back to the paste form", async () => {
    const { deps, connected } = fakeDeps({
      mintKey: async () => {
        throw apiError(501, "agent_fs_too_old");
      },
    });
    expect(await autoConnect(deps, LABEL)).toEqual({ kind: "unsupported" });
    expect(connected).toHaveLength(0);
  });

  test("a 403 (no fs.join.own) explains the missing access and mints nothing", async () => {
    const message = "Your role cannot open files on this swarm. Ask a swarm admin for access.";
    const denied = fakeDeps({
      fsMe: async () => {
        throw apiError(403, "missing permission 'fs.join.own'");
      },
    });
    expect(await autoConnect(denied.deps, LABEL)).toEqual({ kind: "failed", message });
    expect(denied.calls.mint).toEqual([]);
    const mintDenied = fakeDeps({
      mintKey: async () => {
        throw apiError(403, "missing permission 'fs.join.own'");
      },
    });
    expect(await autoConnect(mintDenied.deps, LABEL)).toEqual({ kind: "failed", message });
    expect(mintDenied.connected).toHaveLength(0);
  });

  test("other failures keep the message", async () => {
    const offline = fakeDeps({
      fsMe: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(await autoConnect(offline.deps, LABEL)).toEqual({
      kind: "failed",
      message: "Failed to fetch",
    });
    const limited = fakeDeps({
      mintKey: async () => {
        throw apiError(429, "Limit of five keys per minute reached");
      },
    });
    expect(await autoConnect(limited.deps, LABEL)).toEqual({
      kind: "failed",
      message: "Limit of five keys per minute reached",
    });
    const off = fakeDeps({ fsMe: async () => ({ status: "off", reason: "not configured" }) });
    expect(await autoConnect(off.deps, LABEL)).toEqual({
      kind: "failed",
      message: "not configured",
    });
    expect(off.calls.mint).toEqual([]);
  });
});
