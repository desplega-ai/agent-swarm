import { describe, expect, test } from "bun:test";
import { AgentFsError } from "../../lib/agent-fs/client";
import type { AgentFsCredential } from "../../lib/agent-fs/credential-store";
import { type ConnectFlowDeps, connectWithKey, createAndConnect } from "./connect-flow";

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
  const calls = { register: 0, getMe: 0, ls: 0, invite: [] as string[] };
  const connected: AgentFsCredential[] = [];
  const deps: ConnectFlowDeps = {
    register: async () => {
      calls.register++;
      return { apiKey: KEY };
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
    invite: async (email) => {
      calls.invite.push(email);
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
      expect(calls.ls).toBe(2);
      expect(connected).toHaveLength(1);
    }

    const { deps, calls, connected } = fakeDeps({}, [500]);
    const outcome = await connectWithKey(deps, KEY);
    expect(outcome).toEqual({ kind: "failed", message: "ls failed: 500", newKey: undefined });
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
      newKey: undefined,
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
      newKey: undefined,
    });
    expect(connected).toHaveLength(0);
  });

  test("a 409 register switches to the paste flow", async () => {
    const { deps, calls, connected } = fakeDeps({
      register: async () => {
        throw new AgentFsError(409, "CONFLICT", "Email already registered");
      },
    });
    expect(await createAndConnect(deps, "human@example.com")).toEqual({ kind: "email-taken" });
    expect(calls.getMe).toBe(0);
    expect(connected).toHaveLength(0);
  });

  test("a new registration that cannot finish hands the key back", async () => {
    const { deps, connected } = fakeDeps(
      {
        invite: async () => {
          throw new Error("500");
        },
      },
      [403],
    );
    expect(await createAndConnect(deps, "human@example.com")).toEqual({
      kind: "failed",
      message: "Ask a swarm admin to invite human@example.com to the drive.",
      newKey: KEY,
    });
    expect(connected).toHaveLength(0);
  });

  test("a new registration connects", async () => {
    const { deps, calls, connected } = fakeDeps();
    expect(await createAndConnect(deps, "human@example.com")).toEqual({ kind: "connected" });
    expect(calls.register).toBe(1);
    expect(connected).toHaveLength(1);
  });
});
