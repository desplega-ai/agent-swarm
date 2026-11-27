import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type NewSessionCost,
  type NewSessionLog,
  SESSION_LOG_BATCH_ROWS,
  type SessionSummarySpec,
  type SessionsRepository,
  type SessionTreeRules,
  type Storage,
  sql,
} from "../../src";
import type { ContractEngine } from "./env";

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function newCost(overrides: Partial<NewSessionCost> = {}): NewSessionCost {
  return {
    id: crypto.randomUUID(),
    sessionId: "s1",
    taskId: null,
    agentId: "a1",
    totalCostUsd: 1.5,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningOutputTokens: 0,
    thinkingTokens: 0,
    durationMs: 100,
    numTurns: null,
    model: "m",
    isError: false,
    costSource: "harness",
    harnessCostUsd: null,
    cacheWrite5mTokens: null,
    cacheWrite1hTokens: null,
    modelBreakdown: null,
    credentialKeyType: null,
    credentialKeySuffix: null,
    harness: null,
    kind: "harness",
    ...overrides,
  };
}

export function sessionsContract(engine: ContractEngine): void {
  describe(`sessions repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: SessionsRepository;

    const insertAgent = (id: string) =>
      storage.repos.agents.insertAgent({
        id,
        name: id,
        isLead: false,
        status: "idle",
        maxTasks: 1,
        provider: null,
        harnessProvider: null,
      });
    const insertTask = (
      id: string,
      opts: { parentTaskId?: string | null; requestedByUserId?: string | null } = {},
    ) =>
      storage.executor.run(sql`
        INSERT INTO agent_tasks (id, task, status, "createdAt", "lastUpdatedAt", "parentTaskId", "requestedByUserId")
        VALUES (${id}, 't', 'pending', '2026-11-21T10:00:00.000Z', '2026-11-21T10:00:00.000Z',
          ${opts.parentTaskId ?? null}, ${opts.requestedByUserId ?? null})`);
    const setCostCreatedAt = (id: string, createdAt: string) =>
      storage.executor.run(
        sql`UPDATE session_costs SET "createdAt" = ${createdAt} WHERE id = ${id}`,
      );

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.sessions;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    test("session logs keep insert order and continue line numbers", async () => {
      expect(await repo.lastLogLineNumber("s1", 0)).toBeNull();
      // Line numbers restart (legacy flushes): only insert order orders them.
      for (const [i, lineNumber] of [5, 0, 1].entries()) {
        await repo.insertLog({
          id: `l${i}`,
          taskId: "t1",
          sessionId: "s1",
          iteration: 0,
          cli: "claude",
          content: `line ${i}`,
          lineNumber,
          reasoningChars: null,
          reasoningKind: null,
        });
      }
      expect(await repo.lastLogLineNumber("s1", 0)).toBe(1);
      expect(await repo.lastLogLineNumber("s1", 1)).toBeNull();
      const all = await repo.listLogsByTask("t1");
      expect(all.map((row) => row.id)).toEqual(["l0", "l1", "l2"]);
      expect(all[0]?.createdAt).toMatch(ISO_MS);
      expect((await repo.listLogsByTask("t1", 2)).map((row) => row.id)).toEqual(["l1", "l2"]);
      expect((await repo.listLogsBySession("s1", 0)).map((row) => row.id)).toEqual([
        "l0",
        "l1",
        "l2",
      ]);
    });

    test("batch log insert keeps array order and values across statements", async () => {
      await repo.insertLogs([]);
      const logs: NewSessionLog[] = Array.from(
        { length: SESSION_LOG_BATCH_ROWS * 2 + 1 },
        (_, i) => ({
          id: `b${i}`,
          taskId: i % 2 === 0 ? "t1" : null,
          sessionId: "s1",
          iteration: 0,
          cli: "claude",
          content: `line ${i}`,
          lineNumber: i + 7,
          reasoningChars: i === 3 ? 12 : null,
          reasoningKind: i === 3 ? "reasoning" : null,
        }),
      );
      await repo.insertLogs(logs);
      expect(await repo.lastLogLineNumber("s1", 0)).toBe(logs.length + 6);
      const rows = await repo.listLogsBySession("s1", 0);
      expect(rows.map((row) => row.id)).toEqual(logs.map((log) => log.id));
      expect(rows.map((row) => row.lineNumber)).toEqual(logs.map((log) => log.lineNumber));
      expect(rows[0]?.taskId).toBe("t1");
      expect(rows[1]?.taskId).toBeNull();
      expect(rows[0]?.createdAt).toMatch(ISO_MS);
      const reasoning = await storage.executor.get<{
        reasoningChars: number;
        reasoningKind: string;
      }>(sql`SELECT "reasoningChars", "reasoningKind" FROM session_logs WHERE id = 'b3'`);
      expect(reasoning).toEqual({ reasoningChars: 12, reasoningKind: "reasoning" });
    });

    test("claude reasoning lines carry the message id and can be marked as an update", async () => {
      const since = new Date(Date.now() - 60_000).toISOString();
      await repo.insertLog({
        id: "r1",
        taskId: null,
        sessionId: "s1",
        iteration: 0,
        cli: "claude",
        content: JSON.stringify({ message: { id: "msg-1" } }),
        lineNumber: 0,
        reasoningChars: 12,
        reasoningKind: "reasoning",
      });
      await repo.insertLog({
        id: "r2",
        taskId: null,
        sessionId: "s1",
        iteration: 0,
        cli: "claude",
        content: "plain",
        lineNumber: 1,
        reasoningChars: null,
        reasoningKind: null,
      });
      expect(await repo.listClaudeReasoningLines("s1", since)).toEqual([
        { id: "r1", lineNumber: 0, messageId: "msg-1" },
      ]);
      await repo.markLogReasoningUpdate("r1");
      const row = await storage.executor.get<{ reasoningKind: string }>(
        sql`SELECT "reasoningKind" FROM session_logs WHERE id = 'r1'`,
      );
      expect(row?.reasoningKind).toBe("update");
    });

    test("session costs insert once and list newest first with stated ties", async () => {
      await insertAgent("a1");
      await insertTask("t1");
      await repo.insertSessionCost(newCost({ id: "c1", taskId: "t1", isError: true }));
      // Same id again: no-op.
      await repo.insertSessionCost(newCost({ id: "c1", totalCostUsd: 99 }));
      const c1 = await repo.findSessionCostById("c1");
      expect(c1).toMatchObject({ id: "c1", isError: 1, totalCostUsd: 1.5, taskId: "t1" });
      expect(c1?.createdAt).toMatch(ISO_MS);
      await repo.insertSessionCost(newCost({ id: "c2", taskId: "t1", sessionId: "s2" }));
      await repo.insertSessionCost(newCost({ id: "c3", taskId: "t1", sessionId: "s3" }));
      await setCostCreatedAt("c1", "2026-11-20T10:00:00.000Z");
      await setCostCreatedAt("c2", "2026-11-21T10:00:00.000Z");
      await setCostCreatedAt("c3", "2026-11-21T10:00:00.000Z");
      // By task: ties in insert order.
      expect((await repo.listSessionCostsByTask("t1", 10)).map((r) => r.id)).toEqual([
        "c2",
        "c3",
        "c1",
      ]);
      // By agent and unfiltered: ties newest insert first.
      expect((await repo.listSessionCostsByAgent("a1", 10)).map((r) => r.id)).toEqual([
        "c3",
        "c2",
        "c1",
      ]);
      expect((await repo.listSessionCosts({ limit: 2 })).map((r) => r.id)).toEqual(["c3", "c2"]);
      expect(
        (
          await repo.listSessionCosts({
            agentId: "a1",
            startDate: "2026-11-20T00:00:00.000Z",
            endDate: "2026-11-20T23:59:59.999Z",
            limit: 10,
          })
        ).map((r) => r.id),
      ).toEqual(["c1"]);
      expect((await repo.findSessionCostByIdOrSession("zz", "s2"))?.id).toBe("c2");
      expect((await repo.findSessionCostByIdOrSession("c1", "s2"))?.id).toBe("c1");
    });

    test("daily spend sums one UTC day", async () => {
      await insertAgent("a1");
      await insertAgent("a2");
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u1', 'u')`);
      await insertTask("t1", { requestedByUserId: "u1" });
      await repo.insertSessionCost(newCost({ id: "c1", taskId: "t1", totalCostUsd: 1 }));
      await repo.insertSessionCost(newCost({ id: "c2", agentId: "a2", totalCostUsd: 2 }));
      await repo.insertSessionCost(newCost({ id: "c3", totalCostUsd: 4 }));
      await setCostCreatedAt("c1", "2026-11-21T00:00:00.000Z");
      await setCostCreatedAt("c2", "2026-11-21T23:59:59.999Z");
      await setCostCreatedAt("c3", "2026-11-20T23:59:59.999Z");
      expect(await repo.dailySpendForAgent("a1", "2026-11-21")).toBe(1);
      expect(await repo.dailySpendGlobal("2026-11-21")).toBe(3);
      expect(await repo.dailySpendForUser("u1", "2026-11-21")).toBe(1);
      expect(await repo.dailySpendForUser("u1", "2026-11-19")).toBe(0);
      expect(await repo.dailySpendGlobal("2026-11-20")).toBe(4);
      expect(await repo.dailySpendGlobal("2026-02-30")).toBe(0);
    });

    test("request compositions: seq, count, order with ties", async () => {
      await insertAgent("a1");
      await insertTask("t1");
      expect(await repo.maxRequestCompositionSeq("s1")).toBeNull();
      const row = (
        id: string,
        sessionId: string,
        seq: number,
        createdAt: string,
        source = "worker",
      ) =>
        repo.insertRequestComposition({
          id,
          taskId: "t1",
          agentId: "a1",
          sessionId,
          seq,
          provider: "claude",
          model: null,
          source: source as "worker",
          parts: "[]",
          staticEstTokens: 3,
          tokenRatio: 1,
          createdAt,
        });
      await row("rc1", "s1", 0, "2026-11-21T10:00:00.000Z");
      await row("rc2", "s2", 0, "2026-11-21T10:00:00.000Z");
      await row("rc3", "s1", 1, "2026-11-21T09:00:00.000Z", "harness-hook");
      expect(await repo.countRequestCompositionsByTask("t1")).toBe(3);
      expect(await repo.maxRequestCompositionSeq("s1")).toBe(1);
      expect((await repo.listRequestCompositionsByTask("t1", 10)).map((r) => r.id)).toEqual([
        "rc3",
        "rc1",
        "rc2",
      ]);
      expect((await repo.latestWorkerComposition("s1"))?.id).toBe("rc1");
      await expect(row("dup", "s1", 1, "2026-11-21T11:00:00.000Z")).rejects.toThrow();
    });

    test("dropSessionDescendants removes members of descendants only", async () => {
      await insertTask("root");
      await insertTask("child", { parentTaskId: "root" });
      await insertTask("grandchild", { parentTaskId: "child" });
      await storage.executor.run(sql`DELETE FROM session_members`);
      for (const id of ["root", "child", "grandchild"]) {
        await storage.executor.run(
          sql`INSERT INTO session_members ("taskId", "rootId") VALUES (${id}, 'root')`,
        );
      }
      await repo.dropSessionDescendants("root");
      const left = await storage.executor.query<{ taskId: string }>(
        sql`SELECT "taskId" FROM session_members ORDER BY "taskId"`,
      );
      expect(left.map((r) => r.taskId)).toEqual(["root"]);
    });

    test("summary drift is empty after trigger-maintained writes and reports a broken row", async () => {
      await insertTask("root");
      await insertTask("child", { parentTaskId: "root" });
      expect(await repo.findSessionSummaryDrift(null, ["completed", "failed"])).toEqual([]);
      await storage.executor.run(
        sql`UPDATE session_summaries SET "chainCount" = 7 WHERE "rootId" = 'root'`,
      );
      expect(await repo.findSessionSummaryDrift(null, ["completed", "failed"])).toEqual([
        { rootId: "root", field: "chainCount", expected: 2, stored: 7 },
      ]);
    });

    test("summary drift reports text, number and timestamp fields from a since bound", async () => {
      await insertTask("root");
      await insertTask("child", { parentTaskId: "root" });
      await storage.executor.run(sql`
        UPDATE session_summaries SET "lastActivityAt" = '2026-11-22T00:00:00.000Z', "openTaskCount" = 5,
          "latestStatus" = 'completed'
        WHERE "rootId" = 'root'`);
      expect(
        await repo.findSessionSummaryDrift("2026-11-01T00:00:00.000Z", ["completed", "failed"]),
      ).toEqual([
        {
          rootId: "root",
          field: "lastActivityAt",
          expected: "2026-11-21T10:00:00.000Z",
          stored: "2026-11-22T00:00:00.000Z",
        },
        { rootId: "root", field: "openTasks", expected: 2, stored: 5 },
      ]);
      expect(
        await repo.findSessionSummaryDrift("2026-11-23T00:00:00.000Z", ["completed", "failed"]),
      ).toEqual([]);
    });

    test("budgets upsert, list by key, delete", async () => {
      await repo.upsertBudget("global", "global", 5, 1000);
      await repo.upsertBudget("agent", "b", 1, 1000);
      await repo.upsertBudget("agent", "a", 2, 1000);
      await repo.upsertBudget("agent", "a", 3, 2000);
      expect(await repo.findBudget("agent", "a")).toEqual({
        scope: "agent",
        scope_id: "a",
        daily_budget_usd: 3,
        createdAt: 1000,
        lastUpdatedAt: 2000,
      });
      expect((await repo.listBudgets()).map((b) => `${b.scope}:${b.scope_id}`)).toEqual([
        "agent:a",
        "agent:b",
        "global:global",
      ]);
      expect(await repo.deleteBudget("agent", "a")).toBe(1);
      expect(await repo.deleteBudget("agent", "a")).toBe(0);
      expect(await repo.findBudget("agent", "a")).toBeNull();
    });

    test("budget refusal notifications insert once per task and day", async () => {
      const base = {
        date: "2026-11-21",
        agent_id: "a1",
        cause: "agent",
        agent_spend_usd: 2,
        agent_budget_usd: 1,
        global_spend_usd: null,
        global_budget_usd: null,
        user_spend_usd: null,
        user_budget_usd: null,
      };
      expect(
        await repo.insertBudgetRefusalNotification({ ...base, task_id: "t1", createdAt: 5 }),
      ).toBe(1);
      expect(
        await repo.insertBudgetRefusalNotification({ ...base, task_id: "t1", createdAt: 9 }),
      ).toBe(0);
      expect(
        await repo.insertBudgetRefusalNotification({ ...base, task_id: "t2", createdAt: 5 }),
      ).toBe(1);
      expect(
        await repo.insertBudgetRefusalNotification({ ...base, task_id: "t0", createdAt: 7 }),
      ).toBe(1);
      // INSERT OR IGNORE also skips a row that fails the cause CHECK.
      expect(
        await repo.insertBudgetRefusalNotification({
          ...base,
          cause: "bogus",
          task_id: "t9",
          createdAt: 5,
        }),
      ).toBe(0);
      expect(await repo.findBudgetRefusalNotification("t1", "2026-11-21")).toMatchObject({
        task_id: "t1",
        createdAt: 5,
        follow_up_task_id: null,
      });
      expect(await repo.hasBudgetRefusalNotification("t1", "2026-11-21")).toBe(true);
      expect(await repo.hasBudgetRefusalNotification("t1", "2026-11-22")).toBe(false);
      await repo.setBudgetRefusalFollowUpTaskId("t1", "2026-11-21", "f1");
      expect(
        (await repo.findBudgetRefusalNotification("t1", "2026-11-21"))?.follow_up_task_id,
      ).toBe("f1");
      // Newest first; ties in insert order.
      expect((await repo.listRecentBudgetRefusalNotifications(10)).map((r) => r.task_id)).toEqual([
        "t0",
        "t1",
        "t2",
      ]);
    });

    test("pricing rows: order, active row at a time, plain insert", async () => {
      const row = (model: string, tokenClass: string, effectiveFrom: number, price: number) => ({
        provider: "contract",
        model,
        token_class: tokenClass,
        effective_from: effectiveFrom,
        price_per_million_usd: price,
        createdAt: 1,
        lastUpdatedAt: 1,
      });
      await repo.insertPricingRow(row("m", "input", 100, 1));
      await repo.insertPricingRow(row("m", "input", 200, 2));
      await repo.insertPricingRow(row("m", "cache_read", 100, 3));
      await expect(repo.insertPricingRow(row("m", "input", 200, 9))).rejects.toThrow();
      const mine = (await repo.listPricingRows()).filter((r) => r.provider === "contract");
      expect(mine.map((r) => `${r.token_class}@${r.effective_from}`)).toEqual([
        "cache_read@100",
        "input@200",
        "input@100",
      ]);
      expect(
        (await repo.listPricingRowsFor("contract", "m", "input")).map((r) => r.effective_from),
      ).toEqual([200, 100]);
      expect((await repo.findActivePricingRow("contract", "m", "input", 150))?.effective_from).toBe(
        100,
      );
      expect(await repo.findActivePricingRow("contract", "m", "input", 50)).toBeNull();
      expect(await repo.deletePricingRow("contract", "m", "input", 100)).toBe(1);
      expect(await repo.deletePricingRow("contract", "m", "input", 100)).toBe(0);
      await repo.updatePricingPrice("contract", "m", "input", 200, 7, 500);
      expect(await repo.findActivePricingRow("contract", "m", "input", 250)).toMatchObject({
        price_per_million_usd: 7,
        lastUpdatedAt: 500,
        createdAt: 1,
      });
    });

    test("findActiveSessionIdentity reads the active session by runner or row id", async () => {
      await insertAgent("a1");
      await insertTask("t1");
      await storage.executor.run(sql`
        INSERT INTO active_sessions (id, "agentId", "taskId", "triggerType", "runnerSessionId", "startedAt", "lastHeartbeatAt")
        VALUES ('as1', 'a1', 't1', 'task', 'run-1', '2026-11-21T10:00:00.000Z', '2026-11-21T10:00:00.000Z')`);
      expect(await repo.findActiveSessionIdentity("run-1")).toEqual({
        agentId: "a1",
        taskId: "t1",
      });
      expect(await repo.findActiveSessionIdentity("as1")).toEqual({ agentId: "a1", taskId: "t1" });
      expect(await repo.findActiveSessionIdentity("nope")).toBeNull();
    });

    test("session shares: access, insert-order lists, revoke", async () => {
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u1', 'u'), ('u2', 'v')`);
      await insertTask("root");
      const share = (id: string, userId: string | null, access: string, createdAt: string) =>
        repo.insertShare({ id, rootTaskId: "root", userId, access, createdAt, actor: "u1" });
      await share("sh-b", "u2", "read", "2026-11-21T10:00:00.000Z");
      await share("sh-a", null, "write", "2026-11-21T10:00:00.000Z");
      await share("sh-0", "u1", "read", "2026-11-21T09:00:00.000Z");
      expect((await repo.listActiveShares("root")).map((r) => r.id)).toEqual([
        "sh-0",
        "sh-b",
        "sh-a",
      ]);
      expect((await repo.listShareAccess("root", "u2")).map((r) => r.access).sort()).toEqual([
        "read",
        "write",
      ]);
      expect((await repo.listShareAccess("root", null)).map((r) => r.access)).toEqual(["write"]);
      await repo.revokeShare("sh-b", "2026-11-21T11:00:00.000Z", "u1");
      expect((await repo.listActiveShares("root")).map((r) => r.id)).toEqual(["sh-0", "sh-a"]);
      const history = await repo.listShareHistory("root");
      expect(history.map((r) => r.id)).toEqual(["sh-0", "sh-b", "sh-a"]);
      expect(history[1]).toEqual({
        id: "sh-b",
        rootTaskId: "root",
        userId: "u2",
        access: "read",
        createdAt: "2026-11-21T10:00:00.000Z",
        revokedAt: "2026-11-21T11:00:00.000Z",
        revokedBy: "u1",
      });
    });

    test("listTaskAncestors returns each task of the chains once", async () => {
      await insertTask("root");
      await insertTask("child", { parentTaskId: "root" });
      await insertTask("leaf", { parentTaskId: "child" });
      await insertTask("other");
      const rows = await repo.listTaskAncestors(["leaf", "child", "missing"]);
      expect(rows.map((r) => r.id).sort()).toEqual(["child", "leaf", "root"]);
      expect(rows.find((r) => r.id === "leaf")).toEqual({
        id: "leaf",
        parentTaskId: "child",
        requestedByUserId: null,
        scheduleId: null,
      });
    });

    test("hasChildTaskToken matches the parent token or runtime", async () => {
      const token = (id: string, taskId: string | null, parent: Record<string, string>) =>
        storage.executor.run(sql`
          INSERT INTO session_tokens (id, "tokenHash", "tokenPreview", "agentId", "taskId", "parentTokenId", "parentRuntimeId", "expiresAt")
          VALUES (${id}, ${`h-${id}`}, 'p', 'a1', ${taskId}, ${parent.tokenId ?? null}, ${parent.runtimeId ?? null}, '2099-01-01T00:00:00.000Z')`);
      await token("k1", "t1", { tokenId: "parent" });
      await token("k2", "t1", { runtimeId: "rt" });
      expect(await repo.hasChildTaskToken("k1", "a1", { tokenId: "parent" })).toBe(true);
      expect(await repo.hasChildTaskToken("k1", "a2", { tokenId: "parent" })).toBe(false);
      expect(await repo.hasChildTaskToken("k1", "a1", { runtimeId: "parent" })).toBe(false);
      expect(await repo.hasChildTaskToken("k2", "a1", { runtimeId: "rt" })).toBe(true);
    });

    test("prunePricingHistory keeps the newest rows of each triple", async () => {
      const insert = (tokenClass: string, effectiveFrom: number) =>
        repo.insertPricingRow({
          provider: "contract",
          model: "m",
          token_class: tokenClass,
          effective_from: effectiveFrom,
          price_per_million_usd: 1,
          createdAt: 1,
          lastUpdatedAt: 1,
        });
      for (const at of [100, 300, 200]) await insert("input", at);
      await insert("output", 100);
      const before = (await repo.listPricingRows()).length;
      const deleted = await repo.prunePricingHistory(2);
      expect(deleted).toBeGreaterThanOrEqual(1);
      expect((await repo.listPricingRows()).length).toBe(before - deleted);
      expect(
        (await repo.listPricingRowsFor("contract", "m", "input")).map((r) => r.effective_from),
      ).toEqual([300, 200]);
      expect((await repo.listPricingRowsFor("contract", "m", "output")).length).toBe(1);
    });

    test("cost summaries: credential fallback, user filters, grouped orders with ties", async () => {
      // The migration runner owns `_migrations`; the contract template applies the SQL files only.
      await storage.executor.run(sql`
        CREATE TABLE IF NOT EXISTS _migrations (
          version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`);
      await storage.executor.run(sql`
        INSERT INTO _migrations (version, name, applied_at, checksum)
        VALUES (307, 'session_credentials', '2026-11-01T00:00:00.000Z', 'x')`);
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u1', 'u')`);
      await insertAgent("a1");
      await insertAgent("a2");
      await insertTask("t1", { requestedByUserId: "u1" });
      await storage.executor.run(sql`
        UPDATE agent_tasks SET "credentialKeyType" = 'CODEX_OAUTH', "credentialKeySuffix" = 'old1' WHERE id = 't1'`);
      await insertTask("t2");
      // Legacy row (before 307, no credential): falls back to the task's credential.
      await repo.insertSessionCost(newCost({ id: "c1", taskId: "t1", totalCostUsd: 2 }));
      await setCostCreatedAt("c1", "2026-10-30T10:00:00.000Z");
      // New row with its own credential.
      await repo.insertSessionCost(
        newCost({
          id: "c2",
          taskId: "t2",
          agentId: "a2",
          totalCostUsd: 2,
          credentialKeyType: "ANTHROPIC_API_KEY",
          credentialKeySuffix: "k2",
        }),
      );
      await setCostCreatedAt("c2", "2026-11-20T10:00:00.000Z");
      // New row without a credential: unattributed.
      await repo.insertSessionCost(newCost({ id: "c3", totalCostUsd: 1 }));
      await setCostCreatedAt("c3", "2026-11-20T11:00:00.000Z");
      const filter = { subscriptionKeyTypes: ["CODEX_OAUTH"] };
      expect(await repo.costSummaryTotals(filter)).toMatchObject({
        totalCostUsd: 5,
        totalSessions: 3,
        attributedCostUsd: 2,
        attributableCostUsd: 5,
        excludedCostUsd: 0,
        subscriptionCostUsd: 2,
        credentialUnattributedCostUsd: 1,
        credentialUnattributedSessions: 1,
      });
      expect(
        (await repo.costSummaryDaily(filter)).map((r) => [r.date, r.costUsd, r.sessions]),
      ).toEqual([
        ["2026-10-30", 2, 1],
        ["2026-11-20", 3, 2],
      ]);
      // a1 and a2 tie at 3 vs 2: a1 first; the tie order is the agent id.
      await repo.insertSessionCost(newCost({ id: "c4", agentId: "a2", totalCostUsd: 1 }));
      await setCostCreatedAt("c4", "2026-11-20T12:00:00.000Z");
      expect((await repo.costSummaryByAgent(filter)).map((r) => [r.agentId, r.costUsd])).toEqual([
        ["a1", 3],
        ["a2", 3],
      ]);
      expect((await repo.costSummaryByUser(filter)).map((r) => [r.userId, r.costUsd])).toEqual([
        [null, 4],
        ["u1", 2],
      ]);
      expect(
        (await repo.costSummaryByCredential(filter)).map((r) => [
          r.keyType,
          r.keySuffix,
          r.costUsd,
        ]),
      ).toEqual([
        [null, null, 2],
        ["ANTHROPIC_API_KEY", "k2", 2],
        ["CODEX_OAUTH", "old1", 2],
      ]);
      expect(
        (await repo.costSummaryTotals({ ...filter, user: { kind: "user", userId: "u1" } }))
          ?.totalCostUsd,
      ).toBe(2);
      expect(
        (await repo.costSummaryByAgent({ ...filter, user: { kind: "unattributed" } })).map(
          (r) => r.agentId,
        ),
      ).toEqual(["a2", "a1"]);
      expect(
        (await repo.keyCostSummary()).map((r) => [
          r.keyType,
          r.keySuffix,
          r.totalCost,
          r.taskCount,
        ]),
      ).toEqual([
        ["ANTHROPIC_API_KEY", "k2", 2, 1],
        ["CODEX_OAUTH", "old1", 2, 1],
      ]);
      expect((await repo.keyCostSummary("CODEX_OAUTH")).length).toBe(1);
      expect(
        await repo.dashboardCost("2026-11-20T10:30:00.000Z", "2026-11-01T00:00:00.000Z"),
      ).toEqual({ costToday: 2, costMtd: 4 });
    });

    test("reassignLogsToTask moves a runner session's lines to the task", async () => {
      const log = (id: string, taskId: string | null, sessionId: string) =>
        repo.insertLog({
          id,
          taskId,
          sessionId,
          iteration: 0,
          cli: "claude",
          content: "x",
          lineNumber: 0,
          reasoningChars: null,
          reasoningKind: null,
        });
      await log("l1", "runner", "s1");
      await log("l2", "real", "s1");
      await log("l3", null, "s1");
      await log("l4", "runner", "s2");
      expect(await repo.reassignLogsToTask("s1", "real")).toBe(1);
      expect((await repo.listLogsByTask("real")).map((r) => r.id)).toEqual(["l1", "l2"]);
      expect(await repo.reassignLogsToTask("s1", "real")).toBe(0);
    });

    test("listChainWithCosts walks the chain oldest first with cost sums and insert-order ties", async () => {
      await insertAgent("a1");
      await insertTask("root");
      await insertTask("b", { parentTaskId: "root" });
      await insertTask("a", { parentTaskId: "root" });
      await insertTask("other");
      await storage.executor.run(
        sql`UPDATE agent_tasks SET "createdAt" = '2026-11-21T09:00:00.000Z' WHERE id = 'root'`,
      );
      await repo.insertSessionCost(newCost({ id: "c1", taskId: "a", totalCostUsd: 1 }));
      await repo.insertSessionCost(
        newCost({ id: "c2", taskId: "a", sessionId: "s2", totalCostUsd: 2 }),
      );
      const rows = await repo.listChainWithCosts("root");
      expect(rows.map((r) => [r.id, r.totalCostUsd])).toEqual([
        ["root", null],
        ["b", null],
        ["a", 3],
      ]);
      expect(rows[0]).toMatchObject({ task: "t", status: "pending" });
    });

    // ---- session tree, moves, labels, tokens ----

    const RULES: SessionTreeRules = {
      sourceRanges: [{ source: "slack", lo: "shared/slack/", hi: "shared/slack0" }],
      nestedThreadMinRoots: 2,
      terminalStatuses: ["completed", "failed", "cancelled"],
      agentTaskSources: ["mcp", "system", "schedule", "workflow"],
      machineSources: ["workflow", "schedule", "system"],
      humanSystemTaskTypes: ["kapso-inbound"],
    };
    const NOW = "2026-11-21T12:00:00.000Z";
    const insertRoot = (
      id: string,
      key: string,
      opts: {
        requestedByUserId?: string | null;
        createdAt?: string;
        title?: string;
        task?: string;
      } = {},
    ) =>
      storage.executor.run(sql`
        INSERT INTO agent_tasks (id, task, title, status, "createdAt", "lastUpdatedAt", "key", "requestedByUserId", source)
        VALUES (${id}, ${opts.task ?? "t"}, ${opts.title ?? null}, 'pending', ${opts.createdAt ?? "2026-11-21T10:00:00.000Z"},
          ${opts.createdAt ?? "2026-11-21T10:00:00.000Z"}, ${key}, ${opts.requestedByUserId ?? null}, 'ui')`);
    const summary = (
      userId: string | null,
      root: SessionSummarySpec["root"] = {},
    ): SessionSummarySpec => ({
      root,
      viewerUserId: userId,
      read: userId
        ? {
            now: NOW,
            unreadSince: "2026-11-14T12:00:00.000Z",
            quietBefore: "2026-11-20T12:00:00.000Z",
            inbox: {
              ranges: RULES.sourceRanges,
              noGroup: [
                { lo: "shared/", hi: "shared0", scan: true, start: 8, leafPatterns: ["task:?*/"] },
              ],
            },
          }
        : undefined,
    });

    test("session tree: summaries, counts, thread roots, read state and triage upsert", async () => {
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u1', 'U'), ('u2', 'V')`);
      await insertRoot("r1", "shared/slack/c1/thread:1.2/", { requestedByUserId: "u1" });
      await insertRoot("r2", "shared/slack/c1/thread:1.2/", { requestedByUserId: "u2" });
      await insertRoot("r3", "shared/other/");
      const ids = async (spec: SessionSummarySpec) =>
        (
          await storage.executor.query<{ root_id: string }>(
            sql`SELECT root_id FROM (${repo.sessionSummarySql(RULES, spec)}) q ORDER BY root_id`,
          )
        ).map((row) => row.root_id);
      expect(await ids(summary(null))).toEqual(["r1", "r2", "r3"]);
      expect(
        await ids(summary(null, { keyRange: { lo: "shared/slack/", hi: "shared/slack0" } })),
      ).toEqual(["r1", "r2"]);
      expect(await ids(summary(null, { rootIds: [] }))).toEqual([]);
      expect(await ids(summary("u1", { viewer: { userId: "u1", scope: "mine" } }))).toEqual(["r1"]);
      const count = await storage.executor.get<{ count: number }>(
        repo.sessionCountSql(RULES, summary(null, { sources: ["ui"] }), false),
      );
      expect(Number(count?.count)).toBe(3);
      expect(await repo.listThreadRootCounts(RULES)).toEqual([
        { key: "shared/slack/c1/thread:1.2/", threadRoots: 2 },
      ]);
      expect(await repo.findTaskThreadRoots(RULES, "r1")).toBe(2);
      expect(await repo.findTaskThreadRoots(RULES, "r3")).toBe(0);
      expect(await repo.findTaskThreadRoots(RULES, "missing")).toBeNull();
      expect(await repo.findSessionReadState(RULES, summary("u1", { rootId: "r1" }))).toEqual({
        readState: "unread",
        lastActivityAt: "2026-11-21T10:00:00.000Z",
      });
      expect(await repo.hasReadSession(RULES, summary("u1", { rootId: "r1" }))).toBe(false);

      const write = {
        userId: "u1",
        status: "done" as const,
        doneAt: NOW,
        readAt: null,
        now: NOW,
      };
      expect(
        await repo.triageSessionList(RULES, summary("u1", { rootIds: ["r1", "r3"] }), write),
      ).toBe(2);
      // A second write updates the rows (sticky readAt, kept lastReadAt).
      expect(
        await repo.triageSessionList(RULES, summary("u1", { rootIds: ["r1"] }), {
          ...write,
          status: "open",
          doneAt: null,
          readAt: NOW,
          lastReadAt: { kind: "value", value: "1970-01-01T00:00:00.000Z" },
        }),
      ).toBe(1);
      const rows = await storage.executor.query<Record<string, unknown>>(sql`
        SELECT "itemId", status, "doneAt", "readAt", "lastReadAt" FROM inbox_item_state ORDER BY "itemId"`);
      expect(rows).toEqual([
        {
          itemId: "r1",
          status: "open",
          doneAt: null,
          readAt: NOW,
          lastReadAt: "1970-01-01T00:00:00.000Z",
        },
        { itemId: "r3", status: "done", doneAt: NOW, readAt: null, lastReadAt: null },
      ]);
      // Read once the viewer's cursor passes the chain's last activity.
      await repo.triageSessionList(RULES, summary("u1", { rootIds: ["r1"] }), {
        ...write,
        status: "open",
        doneAt: null,
        readAt: NOW,
        lastReadAt: { kind: "value", value: NOW },
      });
      expect(await repo.findSessionReadState(RULES, summary("u1", { rootId: "r1" }))).toMatchObject(
        {
          readState: "read",
        },
      );
      expect(await repo.hasReadSession(RULES, summary("u1", { rootId: "r1" }))).toBe(true);
      expect(await repo.hasReadSession(RULES, summary("u1", { rootId: "r3" }))).toBe(false);

      const tree = await repo.listSessionTreeRows(RULES, summary("u1"), {
        mine: false,
        userId: "u1",
      });
      expect(
        tree
          .map((row) => [row.root_id, row.defaultVisible, row.needsYou, row.scheduleId])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual([
        ["r1", 1, 0, null],
        ["r2", 1, 0, null],
        ["r3", 0, 0, null],
      ]);
    });

    test("session tree filters and read states agree on summaries and the legacy chain walk", async () => {
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u1', 'U'), ('u2', 'V')`);
      const task = (
        id: string,
        key: string,
        f: {
          parent?: string;
          user?: string;
          status?: string;
          at?: string;
          source?: string;
          title?: string;
          text?: string;
          context?: string;
          schedule?: string;
        } = {},
      ) =>
        storage.executor.run(sql`
          INSERT INTO agent_tasks (id, task, title, status, "createdAt", "lastUpdatedAt", "key", "parentTaskId",
            "requestedByUserId", source, "contextKey", "scheduleId")
          VALUES (${id}, ${f.text ?? "t"}, ${f.title ?? null}, ${f.status ?? "pending"},
            ${f.at ?? "2026-11-21T10:00:00.000Z"}, ${f.at ?? "2026-11-21T10:00:00.000Z"}, ${key},
            ${f.parent ?? null}, ${f.user ?? null}, ${f.source ?? "ui"}, ${f.context ?? null}, ${f.schedule ?? null})`);
      const triage = (
        itemId: string,
        status: string,
        updatedAt: string,
        f: { snooze?: string; lastReadAt?: string } = {},
      ) =>
        storage.executor.run(sql`
          INSERT INTO inbox_item_state ("userId", "itemType", "itemId", status, "snoozeUntil", "lastReadAt", "createdAt", "lastUpdatedAt")
          VALUES ('u1', 'to_read', ${itemId}, ${status}, ${f.snooze ?? null}, ${f.lastReadAt ?? null}, ${updatedAt}, ${updatedAt})`);
      await task("r1", "shared/slack/c1/thread:1.2/", { user: "u1" });
      await task("r2", "shared/slack/c1/thread:1.2/", { user: "u2" });
      await task("r3", "shared/task:r3/");
      await task("r4", "shared/research/", {
        user: "u1",
        title: "Find Bugs",
        text: "Look at the LOGS",
      });
      await task("r4-child", "shared/", {
        parent: "r4",
        user: "u2",
        status: "failed",
        at: "2026-11-21T11:00:00.000Z",
      });
      await task("r5", "shared/task:r5/", {
        user: "u1",
        status: "completed",
        at: "2026-11-01T10:00:00.000Z",
      });
      await task("r6", "shared/slack/c2/", { user: "u1", context: "task:slack:C2" });
      await task("r7", "shared/task:r7/", { user: "u1", source: "schedule", schedule: "sch1" });
      await task("r8", "shared/task:r8/", { user: "u2" });
      await task("r9", "shared/task:r9/", { user: "u1", status: "failed" });
      await task("r10", "shared/task:r10/", {
        user: "u1",
        status: "completed",
        at: "2026-11-01T10:00:00.000Z",
      });
      await storage.executor.run(sql`
        INSERT INTO approval_requests (id, title, questions, approvers, status, "sourceTaskId", "createdAt")
        VALUES ('ap1', 't', '[]', '{}', 'pending', 'r8', '2026-11-21T10:00:00.000Z')`);
      await triage("r4", "snoozed", "2026-11-21T11:30:00.000Z", {
        snooze: "2099-01-01T00:00:00.000Z",
      });
      await triage("r3", "snoozed", "2026-11-21T09:00:00.000Z", {
        snooze: "2000-01-01T00:00:00.000Z",
      });
      await triage("r2", "dismissed", "2026-11-21T09:00:00.000Z");
      await triage("r6", "done", "2026-11-21T09:00:00.000Z");
      await triage("r7", "open", "2026-11-21T09:00:00.000Z", {
        lastReadAt: "2026-11-21T11:00:00.000Z",
      });
      await triage("r10", "done", "2026-11-21T09:00:00.000Z");

      const inbox = {
        ranges: RULES.sourceRanges,
        noGroup: [
          { lo: "shared/", hi: "shared0", scan: true, start: 8, leafPatterns: ["task:?*/"] },
        ],
      };
      const spec = (
        root: SessionSummarySpec["root"],
        extra: Partial<SessionSummarySpec> = {},
      ): SessionSummarySpec => ({ ...summary("u1", root), ...extra });
      const rows = async (s: SessionSummarySpec, legacy = false) =>
        storage.executor.query<Record<string, unknown>>(sql`
          SELECT root_id, "chainCount", "latestStatus", "lastActivityAt", "pendingApproval", "openTasks",
            "readState", "needsYou" FROM (${legacy ? repo.legacySessionSummarySql(RULES, s) : repo.sessionSummarySql(RULES, s)}) q
          ORDER BY root_id`);
      const ids = async (s: SessionSummarySpec) => {
        const fromSummaries = (await rows(s)).map((row) => row.root_id);
        expect((await rows(s, true)).map((row) => row.root_id)).toEqual(fromSummaries);
        return fromSummaries;
      };
      await repo.insertShare({
        id: "sh-r2",
        rootTaskId: "r2",
        userId: "u1",
        access: "read",
        createdAt: NOW,
        actor: null,
      });
      const all = await rows(spec({}));
      expect(await rows(spec({}), true)).toEqual(all);
      expect(
        all.map((row) => [
          row.root_id,
          row.readState,
          row.needsYou,
          row.latestStatus,
          row.chainCount,
          row.openTasks,
          row.pendingApproval,
          row.lastActivityAt,
        ]),
      ).toEqual([
        ["r1", "unread", 0, "pending", 1, 1, 0, "2026-11-21T10:00:00.000Z"],
        ["r10", "done", 0, "completed", 1, 0, 0, "2026-11-01T10:00:00.000Z"],
        ["r2", "done", 0, "pending", 1, 1, 0, "2026-11-21T10:00:00.000Z"],
        ["r3", "unread", 0, "pending", 1, 1, 0, "2026-11-21T10:00:00.000Z"],
        ["r4", "later", 0, "failed", 2, 1, 0, "2026-11-21T11:00:00.000Z"],
        ["r5", "done", 0, "completed", 1, 0, 0, "2026-11-01T10:00:00.000Z"],
        ["r6", "unread", 0, "pending", 1, 1, 0, "2026-11-21T10:00:00.000Z"],
        ["r7", "read", 0, "pending", 1, 1, 0, "2026-11-21T10:00:00.000Z"],
        ["r8", "unread", 1, "pending", 1, 1, 1, "2026-11-21T10:00:00.000Z"],
        ["r9", "unread", 1, "failed", 1, 0, 0, "2026-11-21T10:00:00.000Z"],
      ]);
      // Without a viewer there is no read state.
      expect((await rows(summary(null))).map((row) => row.readState)).toEqual(Array(10).fill(null));
      const cases: [SessionSummarySpec, string[]][] = [
        [spec({ inbox }, { triage: "inbox" }), ["r8", "r9"]],
        [spec({ inbox }, { triage: "working" }), ["r1", "r3", "r6", "r7"]],
        [spec({ marked: { triage: "later", userId: "u1" } }, { triage: "later" }), ["r4"]],
        [
          spec({ marked: { triage: "done", userId: "u1", orInbox: inbox } }, { triage: "done" }),
          ["r10", "r2", "r5"],
        ],
        [spec({}, { triage: "unread" }), ["r1", "r3", "r6", "r8", "r9"]],
        [spec({}, { excludesTriaged: true }), ["r1", "r3", "r6", "r7", "r8", "r9"]],
        [spec({}, { status: "running" }), ["r1", "r2", "r3", "r6", "r7", "r8"]],
        [spec({}, { status: "failed" }), ["r4", "r9"]],
        [spec({}, { status: "needs" }), ["r8", "r9"]],
        [spec({}, { withUserId: "u2" }), ["r2", "r4", "r8"]],
        [spec({}, { withUserId: "u1" }), ["r1", "r10", "r2", "r4", "r5", "r6", "r7", "r9"]],
        [spec({ textLike: "%logs%" }), ["r4"]],
        [spec({ textLike: "%find b%" }), ["r4"]],
        [spec({ contextKeyPattern: "TASK:slack:%" }), ["r6"]],
        [spec({ hideSources: ["slack"] }), ["r10", "r3", "r4", "r5", "r7", "r8", "r9"]],
        [spec({ showSources: ["slack"] }), ["r1", "r2", "r6"]],
        [spec({ showSources: [], includeScheduleRuns: true }), ["r7"]],
        // Two owned roots at the thread key nest it as its own group.
        [
          spec({
            group: {
              lo: "shared/slack/c1/",
              hi: "shared/slack/c10",
              scan: false,
              start: 17,
              leafPatterns: ["thread:?*/"],
            },
          }),
          [],
        ],
        [
          spec({
            group: {
              lo: "shared/slack/c2/",
              hi: "shared/slack/c20",
              scan: false,
              start: 17,
              leafPatterns: ["thread:?*/"],
            },
          }),
          ["r6"],
        ],
        [spec({ noGroup: inbox.noGroup }), ["r10", "r3", "r5", "r7", "r8", "r9"]],
        [spec({ viewer: { userId: "u1", scope: "shared" } }), ["r2"]],
        [spec({ viewer: { userId: "u2", scope: "all" }, tree: true }), ["r2", "r7", "r8"]],
        [
          spec({ viewer: { userId: "u1", scope: "mine" }, mine: true }),
          ["r1", "r10", "r4", "r5", "r6", "r9"],
        ],
        [
          spec({ viewer: { userId: null, scope: "all", readAll: true }, mine: true }),
          ["r1", "r10", "r2", "r3", "r4", "r5", "r6", "r8", "r9"],
        ],
        [
          spec({
            viewer: { userId: "u1", scope: "mine" },
            mine: true,
            includeScheduleRuns: true,
          }),
          ["r1", "r10", "r4", "r5", "r6", "r7", "r9"],
        ],
        [spec({ exceptRootIds: ["r1", "r2"], sources: ["schedule"] }), ["r7"]],
        [
          spec({
            keyRanges: [
              { lo: "shared/slack/", hi: "shared/slack0" },
              { lo: "shared/task:r1", hi: "shared/task:r10" },
            ],
          }),
          ["r1", "r2", "r6"],
        ],
      ];
      for (const [s, expected] of cases) expect(await ids(s)).toEqual(expected);

      const counted = await storage.executor.get<{ count: number }>(
        repo.sessionCountSql(RULES, spec({}, { triage: "unread" }), true),
      );
      expect(Number(counted?.count)).toBe(5);
      const tree = await repo.listSessionTreeRows(RULES, spec({}, { triage: "unread" }), {
        mine: true,
        userId: "u1",
      });
      expect(
        tree
          .map((row) => [row.root_id, row.defaultVisible, row.needsYou, row.readState])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ).toEqual([
        ["r1", 1, 0, "unread"],
        ["r3", 0, 0, "unread"],
        ["r6", 1, 0, "unread"],
        ["r8", 0, 1, "unread"],
        ["r9", 1, 1, "unread"],
      ]);

      // The read cursor moves to each root's newest activity.
      expect(
        await repo.triageSessionList(RULES, spec({ rootIds: ["r4", "r9"] }), {
          userId: "u1",
          status: "open",
          doneAt: null,
          readAt: NOW,
          now: NOW,
          lastReadAt: { kind: "activity" },
        }),
      ).toBe(2);
      expect(
        await storage.executor.query(sql`
          SELECT "itemId", status, "snoozeUntil", "readAt", "lastReadAt", "lastUpdatedAt" FROM inbox_item_state
          WHERE "itemId" IN ('r4', 'r9') ORDER BY "itemId"`),
      ).toEqual([
        {
          itemId: "r4",
          status: "open",
          snoozeUntil: null,
          readAt: NOW,
          lastReadAt: "2026-11-21T11:00:00.000Z",
          lastUpdatedAt: NOW,
        },
        {
          itemId: "r9",
          status: "open",
          snoozeUntil: null,
          readAt: NOW,
          lastReadAt: "2026-11-21T10:00:00.000Z",
          lastUpdatedAt: NOW,
        },
      ]);
      expect(
        (await rows(spec({ rootIds: ["r4", "r9"] }), true)).map((row) => row.readState),
      ).toEqual(["read", "read"]);
    });

    test("key window usage rows: receipts in the window, older sessions of tasks completed in it, unattributed times", async () => {
      await insertAgent("a1");
      const task = (id: string, status: string, finishedAt: string | null) =>
        storage.executor.run(sql`
          INSERT INTO agent_tasks (id, task, status, "createdAt", "lastUpdatedAt", "finishedAt")
          VALUES (${id}, 't', ${status}, '2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z', ${finishedAt})`);
      await task("done-in", "completed", "2026-11-21T10:30:00.000Z");
      await task("done-out", "completed", "2026-11-19T10:00:00.000Z");
      await task("running", "in_progress", null);
      const key = { credentialKeyType: "anthropic", credentialKeySuffix: "abcd" };
      const cost = async (id: string, createdAt: string, overrides: Partial<NewSessionCost>) => {
        await repo.insertSessionCost(newCost({ id, ...overrides }));
        await setCostCreatedAt(id, createdAt);
      };
      // Receipt rows: the credential's sessions in [start, through).
      await cost("in-done", "2026-11-21T10:10:00.000Z", {
        ...key,
        taskId: "done-in",
        isError: true,
        modelBreakdown: '{"m":1}',
        harness: "claude",
      });
      await cost("in-running", "2026-11-21T10:20:00.000Z", { ...key, taskId: "running" });
      await cost("in-other-key", "2026-11-21T10:20:00.000Z", {
        credentialKeyType: "anthropic",
        credentialKeySuffix: "zzzz",
      });
      await cost("at-through", "2026-11-21T11:00:00.000Z", { ...key });
      // Before the window: counted only through a task completed in it.
      await cost("old-done-in", "2026-11-20T10:00:00.000Z", { ...key, taskId: "done-in" });
      await cost("old-done-out", "2026-11-18T10:00:00.000Z", { ...key, taskId: "done-out" });
      // No credential: only the time of harness sessions in the window.
      await cost("anon", "2026-11-21T10:40:00.000Z", { taskId: "running" });
      await cost("anon-suffix", "2026-11-21T10:45:00.000Z", { credentialKeyType: "anthropic" });
      await cost("anon-other-kind", "2026-11-21T10:50:00.000Z", { kind: "embedding" });
      await cost("anon-early", "2026-11-21T09:00:00.000Z", {});

      const rows = await repo.listKeyWindowUsageRows(
        [{ keyType: "anthropic", keySuffix: "abcd" }],
        "2026-11-21T10:00:00.000Z",
        "2026-11-21T11:00:00.000Z",
      );
      // No stated order: the caller groups the rows.
      const sorted = [...rows].sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          String(a.taskId).localeCompare(String(b.taskId)),
      );
      const base = {
        reasoningOutputTokens: 0,
        thinkingTokens: 0,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      };
      const session = {
        ...base,
        ...key,
        harness: null,
        inputTokens: 10,
        outputTokens: 20,
        model: "m",
        modelBreakdown: null,
        isError: 0,
      };
      const unattributed = {
        ...base,
        taskId: null,
        credentialKeyType: null,
        credentialKeySuffix: null,
        harness: null,
        inputTokens: 0,
        outputTokens: 0,
        model: "",
        modelBreakdown: null,
        isError: 0,
        finishedAt: null,
      };
      expect(sorted).toEqual([
        {
          ...session,
          taskId: "done-in",
          createdAt: "2026-11-20T10:00:00.000Z",
          finishedAt: "2026-11-21T10:30:00.000Z",
        },
        {
          ...session,
          taskId: "done-in",
          harness: "claude",
          modelBreakdown: '{"m":1}',
          isError: 1,
          createdAt: "2026-11-21T10:10:00.000Z",
          finishedAt: "2026-11-21T10:30:00.000Z",
        },
        { ...session, taskId: "running", createdAt: "2026-11-21T10:20:00.000Z", finishedAt: null },
        { ...unattributed, createdAt: "2026-11-21T10:40:00.000Z" },
        { ...unattributed, createdAt: "2026-11-21T10:45:00.000Z" },
      ]);
    });

    test("session page members, shares and thread labels", async () => {
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u1', 'U')`);
      await insertRoot("r1", "shared/k/", {
        requestedByUserId: "u1",
        createdAt: "2026-11-21T09:00:00.000Z",
        task: "ask\n<thread_context>\nold\n</thread_context>\nnow",
      });
      await insertRoot("r2", "shared/k/", {
        title: "  Later  ",
        createdAt: "2026-11-21T09:30:00.000Z",
      });
      await insertRoot("r3", "shared/j/", { title: "   ", task: "plain" });
      const members = await repo.listSessionPageMembers(["r1", "r2"]);
      expect(members.map((row) => [row.root_id, row.id, row.name])).toEqual([
        ["r2", null, null],
        ["r1", "u1", "U"],
      ]);
      await repo.insertShare({
        id: "sh2",
        rootTaskId: "r1",
        userId: null,
        access: "read",
        createdAt: "2026-11-21T10:00:00.000Z",
        actor: null,
      });
      await repo.insertShare({
        id: "sh1",
        rootTaskId: "r1",
        userId: "u1",
        access: "write",
        createdAt: "2026-11-21T10:00:00.000Z",
        actor: null,
      });
      expect(
        (await repo.listSessionPageShares(["r1"])).map((row) => [row.id, row.name, row.access]),
      ).toEqual([
        ["u1", "U", "write"],
        [null, null, "read"],
      ]);
      const labels = await repo.listThreadLabels(["r1", "r2", "r3"], 400);
      expect(labels.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
        { key: "shared/j/", title: null, prompt: "plain" },
        { key: "shared/k/", title: null, prompt: "ask\n\nnow" },
      ]);
    });

    test("page members, thread labels and visible prefix roots: ties and viewer scopes", async () => {
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u1', 'U'), ('u2', 'V')`);
      // Same key and createdAt: the first inserted root labels the thread.
      await insertRoot("z", "shared/k/", { title: "Zed", requestedByUserId: "u2" });
      await insertRoot("a", "shared/k/", { title: "Ay", requestedByUserId: "u1" });
      await insertRoot("m", "shared/j/", { task: "x".repeat(10) });
      expect(await repo.listThreadLabels(["a", "z", "m"], 4)).toEqual(
        expect.arrayContaining([
          { key: "shared/k/", title: "Zed", prompt: "t" },
          { key: "shared/j/", title: null, prompt: "xxxx" },
        ]),
      );
      expect(await repo.listThreadLabels(["a", "z", "m"], 4)).toHaveLength(2);
      // lastUpdatedAt and createdAt tie: id descending.
      expect(
        (await repo.listSessionPageMembers(["a", "z", "m"])).map((row) => row.root_id),
      ).toEqual(["z", "m", "a"]);
      await storage.executor.run(sql`UPDATE agent_tasks SET output = '  done  ' WHERE id = 'a'`);
      expect(
        (await repo.listSessionPageMembers(["a"])).map((row) => [row.id, row.name, row.preview]),
      ).toEqual([["u1", "U", "done"]]);

      await storage.executor.run(sql`UPDATE agent_tasks SET "scheduleId" = 'sch' WHERE id = 'm'`);
      const range = { lo: "shared/", hi: "shared0" };
      expect(await repo.listVisiblePrefixRoots(range, { userId: "u1", scope: "mine" })).toEqual([
        { id: "a" },
      ]);
      // All: unowned, own, scheduled and shared roots.
      expect(await repo.listVisiblePrefixRoots(range, { userId: "u1", scope: "all" })).toEqual([
        { id: "a" },
        { id: "m" },
      ]);
      expect(
        await repo.listVisiblePrefixRoots(range, { userId: "u1", scope: "all", readAll: true }),
      ).toEqual([{ id: "a" }, { id: "m" }, { id: "z" }]);
      expect(await repo.listVisiblePrefixRoots(range, { userId: null, scope: "shared" })).toEqual(
        [],
      );
      await repo.insertShare({
        id: "s1",
        rootTaskId: "z",
        userId: null,
        access: "read",
        createdAt: NOW,
        actor: null,
      });
      expect(await repo.listVisiblePrefixRoots(range, { userId: null, scope: "shared" })).toEqual([
        { id: "z" },
      ]);
      // u2 owns z: not shared with them.
      expect(await repo.listVisiblePrefixRoots(range, { userId: "u2", scope: "shared" })).toEqual(
        [],
      );
    });

    test("source backfill roots: default-key Slack and chat-sdk roots after the cursor, by id, limited", async () => {
      const root = (
        id: string,
        key: string,
        f: {
          parent?: string;
          channel?: string;
          thread?: string;
          context?: string;
        } = {},
      ) =>
        storage.executor.run(sql`
          INSERT INTO agent_tasks (id, task, status, "createdAt", "lastUpdatedAt", "key", "parentTaskId",
            "slackChannelId", "slackThreadTs", "contextKey")
          VALUES (${id}, 't', 'pending', '2026-11-21T10:00:00.000Z', '2026-11-21T10:00:00.000Z', ${key},
            ${f.parent ?? null}, ${f.channel ?? null}, ${f.thread ?? null}, ${f.context ?? null})`);
      await root("b-slack", "shared/", { channel: "C1", thread: "1.2" });
      await root("A-chat", "shared/task:a-chat/", { context: "task:chat-sdk:x" });
      await root("c-moved", "shared/research/", { channel: "C1", thread: "1.2" });
      await root("d-nothread", "shared/", { channel: "C1" });
      await root("e-other", "shared/", { context: "task:other:x" });
      await root("f-child", "shared/", { parent: "b-slack", channel: "C1", thread: "1.2" });
      await root("g-slack", "shared/task:g-slack/", { channel: "C2", thread: "3.4" });
      const ids = async (after: string, limit: number) =>
        (await repo.listSourceBackfillRoots(after, limit)).map((row) => row.id);
      expect(await ids("", 10)).toEqual(["A-chat", "b-slack", "g-slack"]);
      expect(await ids("", 2)).toEqual(["A-chat", "b-slack"]);
      expect(await ids("b-slack", 10)).toEqual(["g-slack"]);
      expect((await repo.listSourceBackfillRoots("", 1))[0]).toEqual({
        id: "A-chat",
        slackChannelId: null,
        slackThreadTs: null,
        contextKey: "task:chat-sdk:x",
      });
    });

    test("session moves: keys, prefix roots, chains, favorites", async () => {
      await storage.executor.run(sql`INSERT INTO users (id, name) VALUES ('u1', 'U'), ('u2', 'V')`);
      await insertRoot("b", "shared/g/");
      await insertRoot("a", "shared/g/x/", { requestedByUserId: "u1" });
      await insertRoot("c", "shared/h/");
      await insertTask("a-child", { parentTaskId: "a" });
      await insertTask("a-grandchild", { parentTaskId: "a-child" });
      const range = { lo: "shared/g/", hi: "shared/g0" };
      expect(await repo.listPrefixRoots({ range, limit: 10, offset: 0 })).toEqual([
        { id: "a", key: "shared/g/x/" },
        { id: "b", key: "shared/g/" },
      ]);
      expect(await repo.listPrefixRoots({ range, limit: 1, offset: 1 })).toEqual([
        { id: "b", key: "shared/g/" },
      ]);
      expect(await repo.listPrefixRoots({ range, userId: null, limit: 10, offset: 0 })).toEqual([]);
      expect(
        (await repo.listPrefixRoots({ range, userId: "u1", limit: 10, offset: 0 })).map(
          (r) => r.id,
        ),
      ).toEqual(["a"]);
      await repo.insertShare({
        id: "s1",
        rootTaskId: "a",
        userId: null,
        access: "read",
        createdAt: NOW,
        actor: null,
      });
      expect(await repo.listVisiblePrefixRoots(range, { userId: "u2", scope: "shared" })).toEqual([
        { id: "a" },
      ]);
      expect(await repo.listVisiblePrefixRoots(range, { userId: "u1", scope: "shared" })).toEqual(
        [],
      );
      await repo.setTaskKey("b", "shared/moved/", "u1");
      expect(await repo.findTaskKeyAndParent("b")).toEqual({
        key: "shared/moved/",
        parentTaskId: null,
      });
      expect(await repo.findTaskKeyAndParent("a-child")).toEqual({
        key: "shared/",
        parentTaskId: "a",
      });
      expect(await repo.findTaskKeyAndParent("missing")).toBeNull();
      const updated = await storage.executor.get<{ lastUpdatedAt: string; updated_by: string }>(
        sql`SELECT "lastUpdatedAt", updated_by FROM agent_tasks WHERE id = 'b'`,
      );
      expect(updated).toEqual({ lastUpdatedAt: "2026-11-21T10:00:00.000Z", updated_by: "u1" });
      expect((await repo.listChainTaskIds("a")).sort()).toEqual(["a", "a-child", "a-grandchild"]);

      const fav = (id: string, scope: string, itemId: string) =>
        storage.executor.run(sql`
          INSERT INTO user_favorites (id, "favoriteScope", "itemType", "itemId") VALUES (${id}, ${scope}, 'key', ${itemId})`);
      await fav("f1", "p1", "shared/g/");
      await fav("f2", "p1", "shared/n/");
      await fav("f3", "p2", "shared/g/x/");
      await fav("f4", "p3", "shared/g/");
      await repo.moveKeyFavorites(range, "shared/n/", "p1");
      expect(
        await storage.executor.query(sql`SELECT id, "itemId" FROM user_favorites ORDER BY id`),
      ).toEqual([
        // p1 already starred the new key: the old row goes.
        { id: "f2", itemId: "shared/n/" },
        { id: "f3", itemId: "shared/g/x/" },
        { id: "f4", itemId: "shared/g/" },
      ]);
      await repo.moveKeyFavorites(range, "shared/n/");
      expect(
        await storage.executor.query(sql`SELECT id, "itemId" FROM user_favorites ORDER BY id`),
      ).toEqual([
        { id: "f2", itemId: "shared/n/" },
        { id: "f3", itemId: "shared/n/x/" },
        { id: "f4", itemId: "shared/n/" },
      ]);
    });

    test("session labels: live kv values and resource names", async () => {
      await storage.executor.run(sql`
        INSERT INTO kv_entries (namespace, key, value, value_type, expires_at, created_at, updated_at) VALUES
          ('session-labels', 'k1', 'one', 'string', NULL, 1, 1),
          ('session-labels', 'k2', 'two', 'string', 5000, 1, 1),
          ('session-labels', 'k3', 'three', 'string', 1000, 1, 1),
          ('other', 'k1', 'x', 'string', NULL, 1, 1)`);
      const live = await repo.listLiveKvValues("session-labels", ["k1", "k2", "k3", "k4"], 2000);
      expect(live.sort((a, b) => a.key.localeCompare(b.key))).toEqual([
        { key: "k1", value: "one" },
        { key: "k2", value: "two" },
      ]);
      await storage.executor.run(sql`
        INSERT INTO workflows (id, name, definition, triggers, enabled, "createdAt", "lastUpdatedAt") VALUES
          ('ABC', '  Named  ', '{"nodes":[]}', '[]', ${true}, ${NOW}, ${NOW}),
          ('def', '', '{"nodes":[]}', '[]', ${true}, ${NOW}, ${NOW})`);
      const names = await repo.listResourceNames("workflow", ["ABC", "def", "zzz"]);
      expect(names.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "abc", name: "Named" },
        { id: "def", name: null },
      ]);
    });

    test("session tokens: mint, bindings, revocation, rotation and lookup", async () => {
      const base = {
        tokenPreview: "prev",
        agentId: "a1",
        taskId: null,
        runtimeId: null,
        parentRuntimeId: null,
        expiresAt: "2099-01-01T00:00:00.000Z",
        createdAt: NOW,
        controllerId: null,
        parentTokenId: null,
        scriptRun: false,
      };
      const mint = (id: string, extra: Partial<typeof base> = {}) =>
        repo.insertSessionToken({ ...base, id, tokenHash: `h-${id}`, ...extra });
      await mint("agent");
      await mint("script", { scriptRun: true });
      await mint("rt", { runtimeId: "run1" });
      await mint("child", { taskId: "t1", parentTokenId: "agent" });
      await mint("rtchild", { taskId: "t1", parentRuntimeId: "run1" });
      await mint("old", { expiresAt: "2000-01-01T00:00:00.000Z" });

      expect(await repo.findSessionTokenScriptRun("script")).toBe(1);
      expect(await repo.findSessionTokenScriptRun("agent")).toBe(0);
      expect(await repo.findSessionTokenScriptRun("missing")).toBeNull();
      expect(await repo.findLiveParentTokenExpiry("agent", "a1", null, NOW)).toBe(base.expiresAt);
      expect(await repo.findLiveParentTokenExpiry("script", "a1", null, NOW)).toBeNull();
      expect(await repo.findLiveParentTokenExpiry("rt", "a1", "run1", NOW)).toBe(base.expiresAt);
      expect(await repo.findLiveParentTokenExpiry("rt", "a1", null, NOW)).toBeNull();
      expect(await repo.findLiveParentTokenExpiry("old", "a1", null, NOW)).toBeNull();
      expect((await repo.listActiveAgentTokenIds("a1", NOW)).sort()).toEqual(["agent"]);
      expect(await repo.findSessionTokenRuntime("rt")).toEqual({ runtimeId: "run1" });
      expect(await repo.findSessionTokenRuntime("missing")).toBeNull();
      expect(await repo.listChildSessionTokenIds(["agent", "rt"])).toEqual(["child"]);
      expect((await repo.listRuntimeSessionTokenIds("run1")).sort()).toEqual(["rt", "rtchild"]);

      await repo.setSessionTokenProvenance("script", {
        sourceStepId: "step",
        sourceScriptRunId: "run",
        objectChain: '["a"]',
        depth: 2,
      });
      const found = await repo.findSessionTokenByHash("h-script");
      expect(found).toMatchObject({
        id: "script",
        agentId: "a1",
        controllerId: null,
        placement: null,
        revokedAt: null,
        sourceStepId: "step",
        sourceScriptRunId: "run",
        objectChain: '["a"]',
        depth: 2,
      });
      expect(await repo.findSessionTokenByHash("nope")).toBeNull();
      await repo.touchSessionToken("agent", NOW);
      expect(
        await storage.executor.get(sql`SELECT "lastUsedAt" FROM session_tokens WHERE id = 'agent'`),
      ).toEqual({ lastUsedAt: NOW });

      // Rotation cuts only later expiries.
      await repo.expireSessionTokensWithChildren(["agent"], "2050-01-01T00:00:00.000Z");
      await repo.expireSessionTokensWithChildren(["old"], "2050-01-01T00:00:00.000Z");
      const expiry = async (id: string) =>
        (
          await storage.executor.get<{ expiresAt: string }>(
            sql`SELECT "expiresAt" FROM session_tokens WHERE id = ${id}`,
          )
        )?.expiresAt;
      expect(await expiry("agent")).toBe("2050-01-01T00:00:00.000Z");
      expect(await expiry("child")).toBe("2050-01-01T00:00:00.000Z");
      expect(await expiry("old")).toBe("2000-01-01T00:00:00.000Z");

      // Revocation keeps the first revokedAt.
      await repo.revokeSessionTokens(["child"], "2026-11-21T12:00:01.000Z");
      await repo.revokeSessionTokens(["child", "agent"], "2026-11-21T12:00:02.000Z");
      await repo.revokeRuntimeSessionTokens("run1", "2026-11-21T12:00:03.000Z");
      expect(
        await storage.executor.query(
          sql`SELECT id, "revokedAt" FROM session_tokens WHERE "revokedAt" IS NOT NULL ORDER BY id`,
        ),
      ).toEqual([
        { id: "agent", revokedAt: "2026-11-21T12:00:02.000Z" },
        { id: "child", revokedAt: "2026-11-21T12:00:01.000Z" },
        { id: "rt", revokedAt: "2026-11-21T12:00:03.000Z" },
        { id: "rtchild", revokedAt: "2026-11-21T12:00:03.000Z" },
      ]);
      expect((await repo.listUnrevokedAgentSessionTokenIds("a1")).sort()).toEqual([
        "old",
        "script",
      ]);
    });
  });
}
