import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type NewSessionCost, type SessionsRepository, type Storage, sql } from "../../src";
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
  });
}
