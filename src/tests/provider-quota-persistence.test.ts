import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeDb,
  getAvailableKeyIndices,
  getKeyStatuses,
  initDb,
  recordKeyRateLimitWindows,
} from "../be/db";
import { runMigrations } from "../be/migrations/runner";
import { normalizeCodexRateLimits } from "../utils/codex-rate-limits";

const fixtureCodexHome = mkdtempSync(join(tmpdir(), "provider-usage-phase1-persist-home-"));
const path = `/tmp/provider-usage-phase1-${crypto.randomUUID()}.sqlite`;
beforeAll(() => {
  initDb(path);
});
afterAll(async () => {
  closeDb();
  rmSync(fixtureCodexHome, { recursive: true, force: true });
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(path + suffix)
      .delete()
      .catch(() => {});
});
const older = "2026-11-08T01:00:00.000Z";
const newer = "2026-11-08T01:01:00.000Z";
async function report(suffix: string, value: unknown, at: string, id = "codex") {
  const quota = normalizeCodexRateLimits(value, at, false, id)!;
  await recordKeyRateLimitWindows(
    "CODEX_OAUTH",
    suffix,
    0,
    quota.windows,
    "global",
    null,
    quota.account,
    quota.replace,
  );
}
async function status(suffix: string) {
  return (await getKeyStatuses("CODEX_OAUTH")).find((s) => s.keySuffix === suffix)!;
}

test("a delayed replacement cannot remove newer windows or account details", async () => {
  await report(
    "newer",
    { primary: { usedPercent: 80 }, secondary: { usedPercent: 10 }, planType: "promax" },
    newer,
  );
  await report("newer", { primary: null, secondary: null, planType: "plus" }, older);
  const row = await status("newer");
  expect(Object.keys(row.rateLimitWindows)).toHaveLength(2);
  expect(row.providerAccount?.limits?.codex?.planRaw).toBe("promax");
});

test("removals survive delayed resurrection and preserve unrelated limits and Claude windows", async () => {
  await report("remove", { primary: { usedPercent: 20 }, secondary: { usedPercent: 50 } }, older);
  await report(
    "remove",
    { primary: { usedPercent: 100 }, normalModelSlug: "model-b", planType: "plus" },
    older,
    "model-b",
  );
  await recordKeyRateLimitWindows("CODEX_OAUTH", "remove", 0, {
    seven_day: { status: "allowed", utilization: 0.2, lastSeenAt: older },
  });
  await report("remove", { primary: null, secondary: null }, newer);
  await report("remove", { primary: { usedPercent: 1 }, secondary: { usedPercent: 1 } }, older);
  const row = await status("remove");
  expect(Object.keys(row.rateLimitWindows).sort()).toEqual(["codex:model-b:primary", "seven_day"]);
  expect(row.providerAccount?.limits?.codex?.observedAt).toBe(newer);
  expect(row.providerAccount?.limits?.["model-b"]?.planRaw).toBe("plus");
});

test("account-only reports persist and Codex rejected windows do not change admission", async () => {
  await report("only", { credits: { hasCredits: false, unlimited: false, balance: "0" } }, newer);
  expect((await status("only")).providerAccount?.limits?.codex?.credits?.hasCredits).toBe(false);
  await report(
    "only",
    { primary: { usedPercent: 100, resetsAt: Math.floor(Date.now() / 1000) + 3600 } },
    newer,
    "opus",
  );
  const available = await getAvailableKeyIndices("CODEX_OAUTH", 1, "global", null, "opus", [
    "only",
  ]);
  expect(available.availableIndices).toEqual([0]);
  expect(available.modelBlockedIndices).toEqual([]);
});

test("replacement-only reports keep a removal watermark", async () => {
  await recordKeyRateLimitWindows("CODEX_OAUTH", "blank", 0, {}, "global", null, undefined, [
    { source: "codex", limitId: "codex", observedAt: newer, slots: ["primary", "secondary"] },
  ]);
  await report("blank", { primary: { usedPercent: 1 } }, older);
  expect((await status("blank")).rateLimitWindows).toEqual({});
});

test("migration applies on fresh and existing databases without changing old rows", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    expect(
      db
        .query(
          "SELECT name FROM pragma_table_info('api_key_status') WHERE name = 'providerAccount'",
        )
        .get(),
    ).not.toBeNull();
    db.run("ALTER TABLE api_key_status DROP COLUMN providerAccount");
    db.run("DELETE FROM _migrations WHERE version = 306");
    db.run(
      "INSERT INTO api_key_status (keyType, keySuffix, keyIndex, rateLimitWindows) VALUES ('CODEX_OAUTH', 'prior', 0, '{}')",
    );
    const before = db
      .query("SELECT * FROM api_key_status WHERE keySuffix = 'prior'")
      .get() as Record<string, unknown>;
    runMigrations(db);
    expect(db.query("SELECT * FROM api_key_status WHERE keySuffix = 'prior'").get()).toEqual({
      ...before,
      providerAccount: null,
    });
    runMigrations(db);
    expect(db.query("SELECT COUNT(*) AS n FROM _migrations WHERE version = 306").get()).toEqual({
      n: 1,
    });
  } finally {
    db.close();
  }
});

test("a newer removal does not delete a retained window from a newer worker", async () => {
  await report("mixed", { primary: { usedPercent: 40 } }, "2026-11-08T01:00:30.000Z");
  const initial = normalizeCodexRateLimits({ primary: { usedPercent: 10 } }, older)!;
  await recordKeyRateLimitWindows(
    "CODEX_OAUTH",
    "mixed",
    0,
    initial.windows,
    "global",
    null,
    { source: "codex", observedAt: newer, limits: { codex: { observedAt: newer } } },
    [{ source: "codex", limitId: "codex", observedAt: newer, slots: ["primary", "secondary"] }],
  );
  expect((await status("mixed")).rateLimitWindows["codex:codex:primary"]?.utilization).toBe(0.4);
});

test("a fake native app-server persists only its weekly primary window", async () => {
  const { CodexAdapter } = await import("../providers/codex-adapter");
  const listeners = new Set<(event: { method: string; params?: unknown }) => void>();
  const emit = (method: string, params: unknown) => {
    for (const listener of listeners) listener({ method, params });
  };
  const logFile = `/tmp/provider-usage-phase1-native-${crypto.randomUUID()}.log`;
  let reads = 0;
  let closed = false;
  const client = {
    async request(method: string, _params: unknown, options?: { timeoutMs: number }) {
      if (method === "thread/start") return { thread: { id: "native-weekly" } };
      if (method === "account/rateLimits/read") {
        reads++;
        expect(options?.timeoutMs).toBe(5000);
        return {
          rateLimits: { primary: { usedPercent: 33, windowDurationMins: 10080 }, secondary: null },
        };
      }
      if (method === "turn/start") {
        queueMicrotask(() =>
          emit("turn/completed", {
            threadId: "native-weekly",
            turn: { id: "turn", status: "completed" },
          }),
        );
        return { turn: { id: "turn" } };
      }
    },
    onNotification(listener: (event: { method: string; params?: unknown }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose() {
      return () => {};
    },
    async close() {
      closed = true;
    },
  };
  try {
    expect(fixtureCodexHome.startsWith(join(tmpdir(), "provider-usage-phase1-persist-home-"))).toBe(
      true,
    );
    const session = await new CodexAdapter({
      bypassSubprocess: true,
      appServerFactory: () => client as never,
    }).createSession({
      prompt: "quota fixture",
      systemPrompt: "",
      model: "gpt-5.4",
      role: "worker",
      agentId: crypto.randomUUID(),
      taskId: "",
      apiUrl: "",
      apiKey: "",
      env: { CODEX_HOME: fixtureCodexHome },
      cwd: "/tmp",
      logFile,
    });
    const result = await session.waitForCompletion();
    expect(result.isError).toBe(false);
    await recordKeyRateLimitWindows(
      "CODEX_OAUTH",
      "native",
      0,
      result.rateLimitWindows ?? {},
      "global",
      null,
      result.providerAccount,
      result.rateLimitReplacements,
    );
    const row = await status("native");
    expect(Object.keys(row.rateLimitWindows)).toEqual(["codex:codex:primary"]);
    expect(row.rateLimitWindows["codex:codex:primary"]?.durationMins).toBe(10080);
    expect(reads).toBe(1);
    expect(closed).toBe(true);
    expect(listeners.size).toBe(0);
  } finally {
    await Bun.file(logFile)
      .delete()
      .catch(() => {});
  }
});

test("persistence retains sparse window metadata and per-field account freshness", async () => {
  const initialAt = "2026-11-01T01:00:00.000Z";
  const initial = normalizeCodexRateLimits(
    {
      primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1793581200 },
      limitName: "Weekly",
      normalModelSlug: "model",
      planType: "pro",
      credits: { hasCredits: true, unlimited: false, balance: "8" },
    },
    initialAt,
  )!;
  await recordKeyRateLimitWindows(
    "CODEX_OAUTH",
    "sparse",
    0,
    initial.windows,
    "global",
    null,
    { ...initial.account, ordinaryUsageAllowed: false },
    initial.replace,
  );
  const update = normalizeCodexRateLimits(
    {
      primary: { usedPercent: 1, windowDurationMins: null, resetsAt: null },
      limitName: null,
      normalModelSlug: null,
      planType: null,
      credits: null,
    },
    newer,
    true,
  )!;
  await recordKeyRateLimitWindows(
    "CODEX_OAUTH",
    "sparse",
    0,
    update.windows,
    "global",
    null,
    update.account,
    update.replace,
  );
  const row = await status("sparse");
  expect(row.rateLimitWindows["codex:codex:primary"]).toMatchObject({
    status: "allowed",
    durationMins: 10080,
    resetsAt: 1793581200,
    label: "Weekly",
    normalModelSlug: "model",
    fieldObservedAt: { resetsAt: initialAt },
  });
  expect(row.providerAccount).toMatchObject({
    ordinaryUsageAllowed: false,
    fieldObservedAt: { ordinaryUsageAllowed: initialAt },
    limits: {
      codex: {
        planRaw: "pro",
        credits: { balance: "8" },
        fieldObservedAt: { planRaw: initialAt, credits: initialAt },
      },
    },
  });
});

test("structured DB scrubbing retains valid JSON and removal timestamps", async () => {
  const secret = 'quota-"secret\\1234';
  const { registerVolatileSecret, unregisterVolatileSecret } = await import(
    "../utils/secret-scrubber"
  );
  registerVolatileSecret(secret, "provider-usage-corrections");
  try {
    const initial = normalizeCodexRateLimits(
      {
        limitId: secret,
        primary: { usedPercent: 20 },
        limitName: secret.repeat(12),
        planType: secret,
        credits: { hasCredits: true, unlimited: false, balance: secret },
      },
      older,
    )!;
    await recordKeyRateLimitWindows(
      "CODEX_OAUTH",
      "scrubbed",
      0,
      initial.windows,
      "global",
      null,
      initial.account,
      initial.replace,
    );
    const first = await status("scrubbed");
    expect(first.providerAccount).not.toBeNull();
    expect(JSON.stringify(first)).not.toContain(secret);
    const id = Object.keys(first.providerAccount!.limits!)[0]!;
    expect(first.providerAccount?.limits?.[id]?.planRaw).toContain("REDACTED");
    expect(Object.values(first.rateLimitWindows)[0]?.label?.length).toBeLessThanOrEqual(256);
    const removal = normalizeCodexRateLimits({ limitId: secret, primary: null }, newer)!;
    await recordKeyRateLimitWindows(
      "CODEX_OAUTH",
      "scrubbed",
      0,
      removal.windows,
      "global",
      null,
      removal.account,
      removal.replace,
    );
    await recordKeyRateLimitWindows(
      "CODEX_OAUTH",
      "scrubbed",
      0,
      initial.windows,
      "global",
      null,
      initial.account,
      initial.replace,
    );
    const last = await status("scrubbed");
    expect(last.rateLimitWindows).toEqual({});
    expect(last.providerAccount?.limits?.[id]?.windowRemovedAt?.primary).toBe(newer);
  } finally {
    unregisterVolatileSecret("provider-usage-corrections");
  }
});
