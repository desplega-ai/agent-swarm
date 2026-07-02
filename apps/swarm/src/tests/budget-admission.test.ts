import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { __resetKillSwitchWarnedForTests, canClaim } from "../be/budget-admission";
import {
  closeDb,
  createAgent,
  createSessionCost,
  getBudgetRefusalNotification,
  getDailySpendForAgent,
  getDb,
  hasBudgetRefusalNotificationToday,
  initDb,
  recordBudgetRefusalNotification,
} from "../be/db";

const TEST_DB_PATH = "./test-budget-admission.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

beforeAll(() => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

// Reset DB-side budget / notification / session_cost rows between tests so
// each test starts from a known empty slate. We don't tear the whole DB down
// — initDb() in beforeAll is enough.
//
// We also wipe `agents` because session_costs has a FK to agents and the test
// helper `insertSpendForAgent` re-creates agents on demand. Tests don't use
// any other agent-related rows.
beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM session_costs").run();
  db.prepare("DELETE FROM budget_refusal_notifications").run();
  db.prepare("DELETE FROM budgets").run();
  db.prepare("DELETE FROM agents").run();
  ensuredAgentIds.clear();
});

// Always restore the kill-switch env var so it doesn't leak across tests.
afterEach(() => {
  delete process.env.BUDGET_ADMISSION_DISABLED;
  __resetKillSwitchWarnedForTests();
});

// Track which agents we've already created in the current test so we don't
// hit the PK collision on a second `createAgent`. Cleared in `beforeEach`.
const ensuredAgentIds = new Set<string>();

function ensureAgent(agentId: string): void {
  if (ensuredAgentIds.has(agentId)) return;
  createAgent({
    id: agentId,
    name: `agent-${agentId}`,
    isLead: false,
    status: "idle",
  });
  ensuredAgentIds.add(agentId);
}

function insertBudget(scope: "global" | "agent", scopeId: string, dailyBudgetUsd: number): void {
  getDb()
    .prepare(
      "INSERT INTO budgets (scope, scope_id, daily_budget_usd, createdAt, lastUpdatedAt) VALUES (?, ?, ?, ?, ?)",
    )
    .run(scope, scopeId, dailyBudgetUsd, Date.now(), Date.now());
}

// Pinned to the same UTC day as `NOW` so spend rows fall inside the queried day window regardless of when CI runs.
const DEFAULT_SPEND_CREATED_AT = "2026-04-28T12:00:00.000Z";

function insertSpendForAgent(
  agentId: string,
  totalCostUsd: number,
  opts: { createdAt?: string } = {},
): string {
  ensureAgent(agentId);
  const cost = createSessionCost({
    sessionId: `sess-${crypto.randomUUID()}`,
    agentId,
    totalCostUsd,
    durationMs: 1000,
    numTurns: 1,
    model: "test-model",
  });
  const createdAt = opts.createdAt ?? DEFAULT_SPEND_CREATED_AT;
  getDb().prepare("UPDATE session_costs SET createdAt = ? WHERE id = ?").run(createdAt, cost.id);
  return cost.id;
}

describe("canClaim — budget admission predicate", () => {
  const NOW = new Date("2026-04-28T15:30:00.000Z");
  const TODAY = "2026-04-28";

  test("missing budget rows ⇒ allowed (default unlimited)", () => {
    const result = canClaim("agent-1", NOW);
    expect(result.allowed).toBe(true);
  });

  test("global budget set, spend below ceiling ⇒ allowed", () => {
    insertBudget("global", "", 10.0);
    insertSpendForAgent("agent-x", 3.5);

    const result = canClaim("agent-1", NOW);
    expect(result.allowed).toBe(true);
  });

  test("global budget set, spend at ceiling ⇒ refused with cause='global'", () => {
    insertBudget("global", "", 10.0);
    insertSpendForAgent("agent-x", 7.0);
    insertSpendForAgent("agent-y", 3.0); // exactly hits 10.0

    const result = canClaim("agent-z", NOW);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.cause).toBe("global");
    expect(result.globalSpend).toBe(10.0);
    expect(result.globalBudget).toBe(10.0);
    // Global-cause refusals do not populate agent fields.
    expect(result.agentSpend).toBeUndefined();
    expect(result.agentBudget).toBeUndefined();
  });

  test("agent budget set, agent spend at ceiling ⇒ refused with cause='agent'", () => {
    insertBudget("agent", "agent-1", 5.0);
    insertSpendForAgent("agent-1", 5.0);

    const result = canClaim("agent-1", NOW);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.cause).toBe("agent");
    expect(result.agentSpend).toBe(5.0);
    expect(result.agentBudget).toBe(5.0);
    expect(result.globalSpend).toBeUndefined();
    expect(result.globalBudget).toBeUndefined();
  });

  test("both budgets set + both blown ⇒ refused with cause='global' (global is checked first)", () => {
    insertBudget("global", "", 10.0);
    insertBudget("agent", "agent-1", 2.0);
    insertSpendForAgent("agent-1", 10.0);

    const result = canClaim("agent-1", NOW);
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.cause).toBe("global");
  });

  test("spend on a different UTC day does NOT count toward today", () => {
    insertBudget("agent", "agent-1", 5.0);
    // Backdated cost from yesterday — should not contribute to today's total.
    insertSpendForAgent("agent-1", 50.0, { createdAt: "2026-04-27T23:59:59.999Z" });
    // A small cost today that does not blow the budget.
    insertSpendForAgent("agent-1", 1.0, { createdAt: "2026-04-28T01:00:00.000Z" });

    const todaySpend = getDailySpendForAgent("agent-1", TODAY);
    expect(todaySpend).toBe(1.0);

    const result = canClaim("agent-1", NOW);
    expect(result.allowed).toBe(true);
  });

  test("resetAt for nowUtc=15:30Z is the FOLLOWING UTC midnight", () => {
    insertBudget("global", "", 0.0); // force a refusal so resetAt is set
    const result = canClaim("agent-1", new Date("2026-04-28T15:30:00.000Z"));
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.resetAt).toBe("2026-04-29T00:00:00.000Z");
  });

  test("resetAt at exact UTC midnight rolls forward by +24h, not the current instant", () => {
    insertBudget("global", "", 0.0);
    const result = canClaim("agent-1", new Date("2026-04-28T00:00:00.000Z"));
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.resetAt).toBe("2026-04-29T00:00:00.000Z");
  });

  test("resetAt rolls over month boundary: 2026-04-30T23:59:59.999Z → 2026-05-01T00:00:00.000Z", () => {
    insertBudget("global", "", 0.0);
    const result = canClaim("agent-1", new Date("2026-04-30T23:59:59.999Z"));
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.resetAt).toBe("2026-05-01T00:00:00.000Z");
  });

  test("resetAt rolls over year boundary: 2026-12-31T23:59:59.999Z → 2027-01-01T00:00:00.000Z", () => {
    insertBudget("global", "", 0.0);
    const result = canClaim("agent-1", new Date("2026-12-31T23:59:59.999Z"));
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("unreachable");
    expect(result.resetAt).toBe("2027-01-01T00:00:00.000Z");
  });

  test("BUDGET_ADMISSION_DISABLED=true short-circuits to allowed regardless of budget rows", () => {
    insertBudget("global", "", 0.0); // would refuse without the flag
    insertBudget("agent", "agent-1", 0.0);
    insertSpendForAgent("agent-1", 100.0);

    process.env.BUDGET_ADMISSION_DISABLED = "true";
    const result = canClaim("agent-1", NOW);
    expect(result.allowed).toBe(true);
  });
});

describe("recordBudgetRefusalNotification — idempotent dedup", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM budget_refusal_notifications").run();
  });

  test("first call inserts; second call with same (taskId, date) returns existing row with inserted=false", () => {
    const args = {
      taskId: "task-1",
      date: "2026-04-28",
      agentId: "agent-1",
      cause: "agent" as const,
      agentSpendUsd: 5.0,
      agentBudgetUsd: 5.0,
    };

    const first = recordBudgetRefusalNotification(args);
    expect(first.inserted).toBe(true);
    expect(first.row.taskId).toBe("task-1");
    expect(first.row.date).toBe("2026-04-28");
    expect(first.row.cause).toBe("agent");
    expect(first.row.agentSpendUsd).toBe(5.0);
    expect(first.row.agentBudgetUsd).toBe(5.0);
    expect(first.row.followUpTaskId).toBeUndefined();

    const second = recordBudgetRefusalNotification({
      ...args,
      // Different cause/spend — should still be ignored, returning the original row.
      cause: "global",
      agentSpendUsd: 999,
      agentBudgetUsd: 999,
    });
    expect(second.inserted).toBe(false);
    expect(second.row.cause).toBe("agent"); // original
    expect(second.row.agentSpendUsd).toBe(5.0); // original
    expect(second.row.agentBudgetUsd).toBe(5.0); // original
    expect(second.row.createdAt).toBe(first.row.createdAt);
  });

  test("same task on a different date inserts a new row", () => {
    const first = recordBudgetRefusalNotification({
      taskId: "task-1",
      date: "2026-04-28",
      agentId: "agent-1",
      cause: "agent",
    });
    expect(first.inserted).toBe(true);

    const next = recordBudgetRefusalNotification({
      taskId: "task-1",
      date: "2026-04-29",
      agentId: "agent-1",
      cause: "agent",
    });
    expect(next.inserted).toBe(true);
    expect(next.row.date).toBe("2026-04-29");
  });

  test("hasBudgetRefusalNotificationToday observes presence/absence", () => {
    expect(hasBudgetRefusalNotificationToday("task-1", "2026-04-28")).toBe(false);

    recordBudgetRefusalNotification({
      taskId: "task-1",
      date: "2026-04-28",
      agentId: "agent-1",
      cause: "global",
      globalSpendUsd: 12.5,
      globalBudgetUsd: 10.0,
    });

    expect(hasBudgetRefusalNotificationToday("task-1", "2026-04-28")).toBe(true);
    expect(hasBudgetRefusalNotificationToday("task-1", "2026-04-29")).toBe(false);
  });

  test("getBudgetRefusalNotification round-trips global-cause fields", () => {
    recordBudgetRefusalNotification({
      taskId: "task-2",
      date: "2026-04-28",
      agentId: "agent-1",
      cause: "global",
      globalSpendUsd: 12.5,
      globalBudgetUsd: 10.0,
    });

    const row = getBudgetRefusalNotification("task-2", "2026-04-28");
    expect(row).not.toBeNull();
    expect(row?.cause).toBe("global");
    expect(row?.globalSpendUsd).toBe(12.5);
    expect(row?.globalBudgetUsd).toBe(10.0);
    expect(row?.agentSpendUsd).toBeUndefined();
    expect(row?.agentBudgetUsd).toBeUndefined();
  });
});

describe("getDailySpendForAgent — uses an agentId-leading index (no full table scan)", () => {
  interface ExplainRow {
    id: number;
    parent: number;
    notused: number;
    detail: string;
  }

  test("EXPLAIN QUERY PLAN uses an idx_session_costs_agent* index", () => {
    // Both `idx_session_costs_agentId` (single-column) and
    // `idx_session_costs_agent_createdAt` (composite) lead with `agentId`, so
    // either one is a valid plan — SQLite's optimizer picks based on stats.
    // What we MUST avoid is a full table scan ("SCAN session_costs" without
    // "USING INDEX"). The assertion below covers both index choices and
    // explicitly fails on a bare scan.
    const rows = getDb()
      .prepare<ExplainRow, [string, string]>(
        "EXPLAIN QUERY PLAN SELECT COALESCE(SUM(totalCostUsd), 0) as total FROM session_costs WHERE agentId = ? AND substr(createdAt, 1, 10) = ?",
      )
      .all("agent-1", "2026-04-28");

    const detail = rows.map((r) => r.detail).join(" | ");
    expect(detail).toMatch(/USING INDEX idx_session_costs_agent/);
  });
});
