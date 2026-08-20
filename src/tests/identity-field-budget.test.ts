import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  closeDb,
  createAgent,
  getAgentById,
  getDbClient,
  initDb,
  updateAgentProfile,
} from "../be/db";
import { postHookProfileUpdate } from "../hooks/hook";
import { BOOTSTRAP_MAX_CHARS } from "../prompts/base-prompt";
import {
  checkIdentityFieldBudget,
  IDENTITY_FIELD_BUDGETS,
  IDENTITY_MD_MAX_CHARS,
  IdentityFieldBudgetError,
  SOUL_MD_MAX_CHARS,
} from "../utils/identity-field-budget";

const TEST_DB_PATH = "./test-identity-field-budget.sqlite";

describe("checkIdentityFieldBudget", () => {
  test("exports the session-injection budgets from one policy module", () => {
    expect(SOUL_MD_MAX_CHARS).toBe(10_000);
    expect(IDENTITY_MD_MAX_CHARS).toBe(10_000);
    expect(IDENTITY_FIELD_BUDGETS.claudeMd).toBe(BOOTSTRAP_MAX_CHARS);
    expect(IDENTITY_FIELD_BUDGETS.toolsMd).toBe(BOOTSTRAP_MAX_CHARS);
  });

  test("accepts writes at or below budget, including growth", () => {
    expect(
      checkIdentityFieldBudget({
        field: "soulMd",
        currentValue: "x",
        nextValue: "x".repeat(SOUL_MD_MAX_CHARS),
      }),
    ).toEqual({ ok: true });
  });

  test("accepts a shrinking write while the result remains over budget", () => {
    expect(
      checkIdentityFieldBudget({
        field: "identityMd",
        currentValue: "x".repeat(12_000),
        nextValue: "x".repeat(11_999),
      }),
    ).toEqual({ ok: true });
  });

  test("rejects growth and accepts equal-length rewrites while over budget", () => {
    const growing = checkIdentityFieldBudget({
      field: "claudeMd",
      currentValue: "x".repeat(BOOTSTRAP_MAX_CHARS + 1),
      nextValue: "x".repeat(BOOTSTRAP_MAX_CHARS + 2),
    });
    const equal = checkIdentityFieldBudget({
      field: "toolsMd",
      currentValue: "x".repeat(BOOTSTRAP_MAX_CHARS + 1),
      nextValue: "y".repeat(BOOTSTRAP_MAX_CHARS + 1),
    });

    expect(growing.ok).toBeFalse();
    expect(equal).toEqual({ ok: true });
    if (growing.ok) throw new Error("Expected budget rejection");
    expect(growing.reason).toContain("claudeMd");
    expect(growing.reason).toContain("current size 20001");
    expect(growing.reason).toContain("budget 20000");
    expect(growing.reason).toContain("delta +1");
    expect(growing.reason).toBe(
      "Update rejected for claudeMd: current size 20001 characters, budget 20000 characters, delta +1 characters." +
        " The tail past the 20000-character cap is dropped from the base prompt and only reaches harnesses with a native CLAUDE.md loader." +
        " Move durable content into memories and keep pointers to it in this field.",
    );

    const toolsGrowth = checkIdentityFieldBudget({
      field: "toolsMd",
      currentValue: "x".repeat(BOOTSTRAP_MAX_CHARS + 1),
      nextValue: "x".repeat(BOOTSTRAP_MAX_CHARS + 2),
    });
    if (toolsGrowth.ok) throw new Error("Expected toolsMd budget rejection");
    expect(toolsGrowth.reason).toBe(
      "Update rejected for toolsMd: current size 20001 characters, budget 20000 characters, delta +1 characters." +
        " Content past the 20000-character cap is already silently dropped at read time, so shrinking that tail loses nothing sessions currently receive." +
        " Move durable content into memories and keep pointers to it in this field.",
    );
  });
});

describe("updateAgentProfile identity budget enforcement", () => {
  const agentId = "identity-budget-agent";

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      await Bun.file(TEST_DB_PATH + suffix)
        .delete()
        .catch(() => {});
    }
    initDb(TEST_DB_PATH);
    await createAgent({
      id: agentId,
      name: "Identity Budget Agent",
      isLead: false,
      status: "idle",
    });
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      await Bun.file(TEST_DB_PATH + suffix)
        .delete()
        .catch(() => {});
    }
  });

  test("preserves in-budget behavior and leaves heartbeatMd ungated", async () => {
    const heartbeat = "h".repeat(25_000);
    const result = await updateAgentProfile(agentId, {
      soulMd: "s".repeat(SOUL_MD_MAX_CHARS),
      heartbeatMd: heartbeat,
    });

    expect(result?.soulMd).toHaveLength(SOUL_MD_MAX_CHARS);
    expect(result?.heartbeatMd).toBe(heartbeat);
  });

  test("allows an existing oversized value to shrink or change at equal length but rejects growth", async () => {
    const current = "c".repeat(BOOTSTRAP_MAX_CHARS + 10);
    await getDbClient().run("UPDATE agents SET claudeMd = ? WHERE id = ?", [current, agentId]);

    const shrunk = "s".repeat(BOOTSTRAP_MAX_CHARS + 9);
    expect((await updateAgentProfile(agentId, { claudeMd: shrunk }))?.claudeMd).toBe(shrunk);

    const equalLength = "e".repeat(shrunk.length);
    expect((await updateAgentProfile(agentId, { claudeMd: equalLength }))?.claudeMd).toBe(
      equalLength,
    );
    await expect(updateAgentProfile(agentId, { claudeMd: `${equalLength}g` })).rejects.toThrow(
      IdentityFieldBudgetError,
    );
    expect((await getAgentById(agentId))?.claudeMd).toBe(equalLength);
  });
});

describe("Stop-hook profile sync visibility", () => {
  test("logs a rejected response with the server's budget reason", async () => {
    const reason =
      "Update rejected for toolsMd: current size 20001 characters, budget 20000 characters, delta +1 characters.";
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await postHookProfileUpdate({
        url: "https://api.example.test/api/agents/agent-1/profile",
        headers: { Authorization: "Bearer secret", "X-Agent-ID": "agent-1" },
        body: { toolsMd: "next", changeSource: "session_sync" },
        label: "identity",
        fetchImpl: (async () =>
          new Response(JSON.stringify({ error: reason }), { status: 400 })) as typeof fetch,
      });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = String(errorSpy.mock.calls[0]?.[0]);
      expect(logged).toContain("identity profile sync failed: HTTP 400");
      expect(logged).toContain(reason);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("logs thrown sync errors without failing shutdown", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        postHookProfileUpdate({
          url: "https://api.example.test/api/agents/agent-1/profile",
          headers: {},
          body: { claudeMd: "next" },
          label: "claudeMd",
          fetchImpl: (async () => {
            throw new Error("network unavailable");
          }) as typeof fetch,
        }),
      ).resolves.toBeUndefined();
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain(
        "claudeMd profile sync errored: network unavailable",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
