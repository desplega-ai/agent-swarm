// A model profile's credential allowlist: the worker picks pooled keys only
// from the allowlisted suffixes (`resolveCredentialPools` → `selectCredential`),
// fails fast when none match, and behaves exactly as before without one. The
// last block drives the real `/api/poll` handler to check the claim trigger
// carries the allowlist.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, createTaskExtended, getDbClient, initDb, pauseTask } from "../be/db";
import { createModelProfile } from "../be/db/model-profiles";
import { fetchResolvedEnv, getPausedTasksFromAPI } from "../commands/runner";
import { handlePoll } from "../http/poll";
import { handleTasks } from "../http/tasks";
import {
  type AvailabilityInfo,
  CredentialAllowlistError,
  keySuffix,
  ModelWindowExhaustedError,
  resolveCredentialPools,
  selectCredential,
} from "../utils/credentials";

const VAR = "CLAUDE_CODE_OAUTH_TOKEN";
// Positions 0..3; the allowlist below names positions 1 and 3.
const POOL = ["tok-aaaaa", "tok-bbbbb", "tok-ccccc", "tok-ddddd"];
const ALLOWED = ["bbbbb", "ddddd"];
const ALLOWED_IDX = [1, 3];

async function pick(
  info: AvailabilityInfo | undefined,
  opts: {
    allow?: Record<string, string[]>;
    model?: string;
    enforceModelCapacity?: boolean;
    localBlocks?: Map<string, number>;
  } = {},
) {
  const env: Record<string, string | undefined> = { [VAR]: POOL.join(",") };
  const selections = await resolveCredentialPools(env, {
    provider: "claude",
    model: opts.model ?? "sonnet",
    availableIndicesMap: info ? { [VAR]: info } : {},
    enforceModelCapacity: opts.enforceModelCapacity,
    localBlocks: opts.localBlocks,
    allowedKeySuffixes: "allow" in opts ? opts.allow : { [VAR]: ALLOWED },
    allowlistProfile: "claude-pinned",
  });
  expect(selections).toHaveLength(1);
  const selection = selections[0]!;
  expect(env[VAR]).toBe(selection.selected);
  return selection;
}

async function indicesOver(draws: number, run: () => ReturnType<typeof pick>) {
  const seen = new Set<number>();
  for (let i = 0; i < draws; i++) seen.add((await run()).index);
  return seen;
}

let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
});

describe("keySuffix", () => {
  test("is the last five characters, the same suffix a task record stamps", () => {
    expect(keySuffix("sk-ant-oat01-xyz12345")).toBe("12345");
    expect(selectCredential("a-11111,b-22222", [1]).keySuffix).toBe(keySuffix("b-22222"));
  });
});

describe("resolveCredentialPools with an allowlist", () => {
  test("maps allowlisted suffixes to their positions in the full 4-key pool", async () => {
    const seen = await indicesOver(200, () => pick(undefined));
    expect([...seen].sort()).toEqual(ALLOWED_IDX);
    const selection = await pick(undefined);
    // Indices stay positions in the full pool: reportKeyUsage and keyIndex are unaffected.
    expect(selection.total).toBe(4);
    expect(selection.selected).toBe(POOL[selection.index]);
    expect(ALLOWED).toContain(selection.keySuffix);
  });

  test("intersects the server's available indices with the allowlist", async () => {
    const seen = await indicesOver(200, () => pick({ availableIndices: [0, 1, 2] }));
    expect([...seen]).toEqual([1]);
    expect((await pick({ availableIndices: [0, 1, 2] })).isRateLimitFallback).toBe(false);
  });

  test("all rate-limited: 1,000 draws never leave the allowlist", async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      const selection = await pick({ availableIndices: [] });
      expect(selection.isRateLimitFallback).toBe(true);
      seen.add(selection.index);
    }
    expect([...seen].sort()).toEqual(ALLOWED_IDX);
  });

  test("only non-allowlisted keys available: picks within the allowlist as a rate-limit fallback", async () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const selection = await pick({ availableIndices: [0, 2] });
      expect(selection.isRateLimitFallback).toBe(true);
      seen.add(selection.index);
    }
    expect([...seen].sort()).toEqual(ALLOWED_IDX);
  });

  test("the seat fallback is restricted to the allowlist", async () => {
    // Key 1 is on a seat without the model; keys 0 and 2 are fine but not allowlisted.
    const info = { availableIndices: [], modelBlockedIndices: [], seatBlockedIndices: [1] };
    const seen = await indicesOver(200, () =>
      pick(info, { model: "opus", enforceModelCapacity: true }),
    );
    expect([...seen]).toEqual([3]);
  });

  test("every allowlisted key seat-blocked fails fast, though other keys could run it", async () => {
    const info = { availableIndices: [], modelBlockedIndices: [], seatBlockedIndices: [1, 3] };
    const error = await pick(info, { model: "opus", enforceModelCapacity: true }).catch((e) => e);
    expect(error).toBeInstanceOf(ModelWindowExhaustedError);
    expect((error as ModelWindowExhaustedError).seatBlockedCount).toBe(2);
  });

  test("window exhaustion is counted over the allowlist only", async () => {
    // Keys 0 and 2 have Opus capacity, but both allowlisted keys are window-blocked.
    const exhausted = {
      availableIndices: [0, 2],
      modelBlockedIndices: [1, 3],
      earliestModelResetAt: "2026-10-20T00:00:00.000Z",
    };
    const error = await pick(exhausted, { model: "opus", enforceModelCapacity: true }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(ModelWindowExhaustedError);
    expect((error as ModelWindowExhaustedError).modelBlockedCount).toBe(2);

    // A window block on a key outside the allowlist does not count: the allowlisted keys
    // are only key-wide rate-limited, so the pick goes ahead within the allowlist.
    const outside = { availableIndices: [2], modelBlockedIndices: [0] };
    const selection = await pick(outside, { model: "opus", enforceModelCapacity: true });
    expect(ALLOWED_IDX).toContain(selection.index);
    expect(selection.isRateLimitFallback).toBe(true);
  });

  test("a local window block on an allowlisted key is counted too", async () => {
    const localBlocks = new Map([[`${VAR}:1:seven_day_opus`, Date.now() + 60_000]]);
    const error = await pick(
      { availableIndices: [0, 1, 2], modelBlockedIndices: [3] },
      { model: "opus", enforceModelCapacity: true, localBlocks },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ModelWindowExhaustedError);
    expect((error as ModelWindowExhaustedError).modelBlockedCount).toBe(2);
  });

  test("zero matches throws CredentialAllowlistError naming the profile and both suffixes", async () => {
    const error = await pick(undefined, { allow: { [VAR]: ["a1b2c", "x9y8z"] } }).catch((e) => e);
    expect(error).toBeInstanceOf(CredentialAllowlistError);
    expect((error as Error).message).toBe(
      `credential allowlist for claude-pinned matches no ${VAR} key (wanted a1b2c, x9y8z)`,
    );
  });

  test("a single-key pool that is not allowlisted throws too", async () => {
    const env = { [VAR]: "tok-only1" };
    await expect(
      resolveCredentialPools(env, {
        provider: "claude",
        allowedKeySuffixes: { [VAR]: ["abcde"] },
      }),
    ).rejects.toBeInstanceOf(CredentialAllowlistError);
  });

  test("a var without an entry keeps its whole pool", async () => {
    const seen = await indicesOver(300, () =>
      pick(undefined, { allow: { ANTHROPIC_API_KEY: ["zzzzz"] } }),
    );
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe("selectCredential allowedIndices", () => {
  test("bounds the pick-anyway branches", () => {
    const value = POOL.join(",");
    for (let i = 0; i < 500; i++) {
      expect(ALLOWED_IDX).toContain(selectCredential(value, [], VAR, ALLOWED_IDX).index);
      expect(ALLOWED_IDX).toContain(selectCredential(value, [7, 9], VAR, ALLOWED_IDX).index);
      expect(ALLOWED_IDX).toContain(selectCredential(value, undefined, VAR, ALLOWED_IDX).index);
    }
  });
});

describe("no allowlist is byte-identical to today", () => {
  /** A fixed pseudo-random sequence, restarted per run. */
  function seeded(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }

  async function runSeeded(
    seed: number,
    info: AvailabilityInfo | undefined,
    allow: Record<string, string[]> | undefined,
  ) {
    const rand = seeded(seed);
    const spy = spyOn(Math, "random").mockImplementation(rand);
    try {
      const out: Array<[number, boolean | undefined]> = [];
      for (let i = 0; i < 50; i++) {
        const s = await pick(info, { allow });
        out.push([s.index, s.isRateLimitFallback]);
      }
      return out;
    } finally {
      spy.mockRestore();
    }
  }

  /** The pre-allowlist picker, inlined: random over all keys, or over the available ones. */
  function legacy(seed: number, available: number[] | undefined) {
    const rand = seeded(seed);
    const out: Array<[number, boolean | undefined]> = [];
    for (let i = 0; i < 50; i++) {
      if (available && available.length > 0) {
        out.push([available[Math.floor(rand() * available.length)]!, false]);
      } else {
        out.push([Math.floor(rand() * POOL.length), available !== undefined]);
      }
    }
    return out;
  }

  for (const [label, available] of [
    ["no availability info", undefined],
    ["some keys available", [0, 2, 3]],
    ["all rate-limited", []],
  ] as const) {
    test(`same seed, same pick: ${label}`, async () => {
      const info = available ? { availableIndices: [...available] } : undefined;
      const expected = legacy(42, available ? [...available] : undefined);
      expect(await runSeeded(42, info, undefined)).toEqual(expected);
      // An allowlist that covers the whole pool draws the same keys too.
      const all = POOL.map(keySuffix);
      expect(await runSeeded(42, info, { [VAR]: all })).toEqual(expected);
    });
  }
});

describe("fetchResolvedEnv forwards the trigger allowlist", () => {
  let server: ReturnType<typeof Bun.serve>;
  let apiUrl: string;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/config/resolved") {
          return Response.json({
            configs: [
              { key: VAR, value: POOL.join(",") },
              { key: "HARNESS_PROVIDER", value: "claude" },
            ],
          });
        }
        if (url.pathname === "/api/keys/available") {
          // Every key rate-limited: the pick-anyway branch must still respect the allowlist.
          return Response.json({ success: true, availableIndices: [], totalKeys: 4 });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    apiUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(() => {
    server.stop(true);
  });

  test("picks only allowlisted keys", async () => {
    for (let i = 0; i < 20; i++) {
      const { env } = await fetchResolvedEnv(apiUrl, "key", "agent-allowlist", {}, "sonnet", {
        provider: "claude",
        enforceModelCapacity: true,
        credentialAllowlist: { [VAR]: ALLOWED },
        resolvedProfile: "claude-pinned",
      });
      expect(ALLOWED).toContain(keySuffix(env[VAR] ?? ""));
    }
  });

  test("throws CredentialAllowlistError when nothing matches", async () => {
    await expect(
      fetchResolvedEnv(apiUrl, "key", "agent-allowlist", {}, "sonnet", {
        provider: "claude",
        enforceModelCapacity: true,
        credentialAllowlist: { [VAR]: ["nomat"] },
        resolvedProfile: "claude-pinned",
      }),
    ).rejects.toThrow(
      "credential allowlist for claude-pinned matches no CLAUDE_CODE_OAUTH_TOKEN key",
    );
  });
});

describe("the claim trigger carries the profile's allowlist", () => {
  const TEST_DB_PATH = "./test-credentials-allowlist.sqlite";

  async function removeDbFiles(path: string): Promise<void> {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(path + suffix);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async function callPoll(agentId: string): Promise<{ task: Record<string, unknown> } | null> {
    let bodyStr = "";
    const req = {
      method: "GET",
      url: "/api/poll",
      headers: { "x-agent-id": agentId },
    } as unknown as Parameters<typeof handlePoll>[0];
    const res = {
      setHeader() {},
      writeHead() {},
      end(body?: string) {
        bodyStr = body ?? "";
      },
    } as unknown as Parameters<typeof handlePoll>[1];
    await handlePoll(req, res, ["api", "poll"], new URLSearchParams(), agentId);
    return (JSON.parse(bodyStr) as { trigger: { task: Record<string, unknown> } | null }).trigger;
  }

  beforeAll(async () => {
    await removeDbFiles(TEST_DB_PATH);
    initDb(TEST_DB_PATH);
  });

  afterAll(async () => {
    closeDb();
    await removeDbFiles(TEST_DB_PATH);
  });

  beforeEach(async () => {
    const client = getDbClient();
    await client.run("DELETE FROM agent_tasks");
    await client.run("DELETE FROM agents");
    await client.run("DELETE FROM model_profiles");
    await createModelProfile({
      name: "claude-pinned",
      harness: "claude",
      model: "opus",
      credentials: { [VAR]: ALLOWED },
    });
    await createModelProfile({ name: "claude-open", harness: "claude", model: "sonnet" });
  });

  async function claim(profile: string | undefined) {
    const w = await createAgent({
      name: `w-${profile ?? "none"}`,
      isLead: false,
      status: "idle",
      maxTasks: 1,
      harnessProvider: "claude",
    });
    await createTaskExtended("work", { agentId: w.id, ...(profile ? { profile } : {}) });
    return (await callPoll(w.id))?.task;
  }

  test("a profile with an allowlist puts it on the trigger", async () => {
    const task = await claim("claude-pinned");
    expect(task).toMatchObject({
      resolvedProfile: "claude-pinned",
      credentialAllowlist: { [VAR]: ALLOWED },
    });
  });

  test("a profile without one, or no profile, leaves it off", async () => {
    expect(await claim("claude-open")).not.toHaveProperty("credentialAllowlist");
    expect(await claim(undefined)).not.toHaveProperty("credentialAllowlist");
  });

  // Paused-task recovery spawns from `GET /api/paused-tasks`, not a claim
  // trigger. Drives the runner's real fetch and key pick over that response.
  test("a paused task resumes on an allowlisted key", async () => {
    const w = await createAgent({
      name: "w-paused",
      isLead: false,
      status: "idle",
      maxTasks: 1,
      harnessProvider: "claude",
    });
    const created = await createTaskExtended("work", { agentId: w.id, profile: "claude-pinned" });
    expect((await callPoll(w.id))?.task.credentialAllowlist).toEqual({ [VAR]: ALLOWED });
    expect(await pauseTask(created.id)).not.toBeNull();

    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/paused-tasks") {
          let body = "";
          const fakeReq = {
            method: "GET",
            url: "/api/paused-tasks",
            headers: { "x-agent-id": w.id },
          } as unknown as Parameters<typeof handleTasks>[0];
          const fakeRes = {
            setHeader() {},
            writeHead() {},
            end(chunk?: string) {
              body = chunk ?? "";
            },
          } as unknown as Parameters<typeof handleTasks>[1];
          await handleTasks(fakeReq, fakeRes, ["api", "paused-tasks"], url.searchParams, w.id);
          return new Response(body, { headers: { "content-type": "application/json" } });
        }
        if (url.pathname === "/api/config/resolved") {
          return Response.json({
            configs: [
              { key: VAR, value: POOL.join(",") },
              { key: "HARNESS_PROVIDER", value: "claude" },
            ],
          });
        }
        if (url.pathname === "/api/keys/available") {
          return Response.json({ success: true, availableIndices: [0, 1, 2, 3], totalKeys: 4 });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    const apiUrl = server.url.toString().replace(/\/$/, "");
    try {
      const [paused] = await getPausedTasksFromAPI({ apiUrl, apiKey: "key", agentId: w.id });
      expect(paused?.id).toBe(created.id);
      const seen = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const { env } = await fetchResolvedEnv(apiUrl, "key", w.id, {}, "opus", {
          provider: "claude",
          taskId: paused!.id,
          enforceModelCapacity: true,
          resolvedProfile: paused!.resolvedProfile,
          credentialAllowlist: paused!.credentialAllowlist,
        });
        seen.add(keySuffix(env[VAR] ?? ""));
      }
      expect([...seen].filter((suffix) => !ALLOWED.includes(suffix))).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});
