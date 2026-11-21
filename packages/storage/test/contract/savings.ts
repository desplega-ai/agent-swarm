import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type SavingsRepository, type Storage, sql } from "../../src";
import type { ContractEngine } from "./env";

export function savingsContract(engine: ContractEngine): void {
  describe(`savings repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: SavingsRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.savings;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const bucket = (computedAt: string, runs: number, modelVersion = 1) => ({
      day: "2026-11-20",
      jobId: "w1",
      jobKey: "wf",
      jobName: "WF",
      facts: { runs, countedRuns: runs, agentUsd: 1.5 },
      modelVersion,
      computedAt,
    });

    test("day markers: a newer scan wins unless the model version changes", async () => {
      await repo.markDay("2026-11-20", "workflow", 1, "2026-11-21T10:00:00.000Z");
      await repo.markDay("2026-11-20", "workflow", 1, "2026-11-21T09:00:00.000Z");
      expect(await repo.findDayMarker("2026-11-20", "workflow", 1)).toEqual({
        computedAt: "2026-11-21T10:00:00.000Z",
      });
      await repo.markDay("2026-11-20", "workflow", 2, "2026-11-21T08:00:00.000Z");
      expect(await repo.findDayMarker("2026-11-20", "workflow", 1)).toBeNull();
      await repo.markDay("2026-11-19", "workflow", 2, "2026-11-21T08:00:00.000Z");
      await repo.markDay("2026-11-20", "script", 2, "2026-11-21T08:00:00.000Z");
      const markers = await repo.listDayMarkers("workflow", "2026-11-20");
      expect(markers).toEqual([
        { day: "2026-11-20", modelVersion: 2, computedAt: "2026-11-21T08:00:00.000Z" },
      ]);
    });

    test("workflow buckets: conditional upsert and stale delete", async () => {
      await repo.upsertWorkflowBucket(bucket("2026-11-21T10:00:00.000Z", 3));
      // Older scan: kept.
      await repo.upsertWorkflowBucket(bucket("2026-11-21T09:00:00.000Z", 9));
      expect(await repo.findWorkflowBucket("2026-11-20", "w1")).toEqual({
        computedAt: "2026-11-21T10:00:00.000Z",
        childTaskUsd: 0,
        childTaskMs: 0,
      });
      const runs = await storage.executor.get<{ runs: number; agentUsd: number }>(
        sql`SELECT runs, "agentUsd" FROM automation_savings_daily WHERE "jobId" = 'w1'`,
      );
      expect(runs).toEqual({ runs: 3, agentUsd: 1.5 });
      // Another model version: replaced even when older.
      await repo.upsertWorkflowBucket(bucket("2026-11-21T08:00:00.000Z", 5, 2));
      expect((await repo.findWorkflowBucket("2026-11-20", "w1"))?.computedAt).toBe(
        "2026-11-21T08:00:00.000Z",
      );
      await repo.deleteStaleWorkflowBuckets("2026-11-20", "2026-11-21T07:00:00.000Z", 2);
      expect(await repo.findWorkflowBucket("2026-11-20", "w1")).not.toBeNull();
      await repo.deleteStaleWorkflowBuckets("2026-11-20", "2026-11-21T08:00:00.000Z", 2);
      expect(await repo.findWorkflowBucket("2026-11-20", "w1")).toBeNull();
    });

    test("script buckets and links replace by key; prune drops old days", async () => {
      const script = (subKind: string, runs: number, day = "2026-11-20") => ({
        day,
        jobId: "s",
        jobKey: "s",
        jobName: "s",
        subKind,
        runs,
        countedRuns: runs,
        effectRuns: 0,
        opsSum: 0,
        computeSecs: 0,
        modelVersion: 1,
        computedAt: "2026-11-21T10:00:00.000Z",
      });
      await repo.replaceScriptBucket(script("", 1));
      await repo.replaceScriptBucket(script("", 4));
      await repo.replaceScriptBucket(script("api", 2));
      await repo.replaceScriptBucket(script("", 7, "2026-11-01"));
      const rows = await storage.executor.query<{ subKind: string; runs: number }>(sql`
        SELECT "subKind", runs FROM automation_savings_daily WHERE day = '2026-11-20' ORDER BY "subKind"`);
      expect(rows).toEqual([
        { subKind: "", runs: 4 },
        { subKind: "api", runs: 2 },
      ]);
      const link = (n: number, day = "2026-11-20") => ({
        day,
        parentJobId: "w1",
        childKind: "script",
        childJobId: "s",
        linkKind: "step-script",
        n,
        actualUsd: 0,
        keptUsd: 0,
        modelVersion: 1,
        computedAt: "2026-11-21T10:00:00.000Z",
      });
      await repo.replaceLink(link(1));
      await repo.replaceLink(link(3));
      await repo.replaceLink(link(1, "2026-11-01"));
      const count = async (table: "automation_savings_links" | "automation_savings_daily") =>
        Number(
          (
            await storage.executor.get<{ n: number }>(
              table === "automation_savings_links"
                ? sql`SELECT COUNT(*) AS n FROM automation_savings_links`
                : sql`SELECT COUNT(*) AS n FROM automation_savings_daily`,
            )
          )?.n,
        );
      expect(await count("automation_savings_links")).toBe(2);
      await repo.markDay("2026-11-01", "script", 1, "2026-11-02T00:00:00.000Z");
      await repo.pruneBefore("2026-11-10");
      expect(await count("automation_savings_links")).toBe(1);
      expect(await count("automation_savings_daily")).toBe(2);
      expect(await repo.listDayMarkers("script", "2026-01-01")).toEqual([]);
      await repo.deleteLinks("2026-11-20");
      await repo.deleteScriptBuckets("2026-11-20");
      expect(await count("automation_savings_links")).toBe(0);
      expect(await count("automation_savings_daily")).toBe(0);
    });

    test("replaceScriptBucket resets the columns it does not name (INSERT OR REPLACE)", async () => {
      const script = (runs: number) => ({
        day: "2026-11-20",
        jobId: "s",
        jobKey: "s",
        jobName: "s",
        subKind: "",
        runs,
        countedRuns: runs,
        effectRuns: 0,
        opsSum: 0,
        computeSecs: 0,
        modelVersion: 1,
        computedAt: "2026-11-21T10:00:00.000Z",
      });
      await repo.replaceScriptBucket(script(1));
      await storage.executor.run(
        sql`UPDATE automation_savings_daily SET "agentUsd" = 2.5, "eventRuns" = 3 WHERE "jobId" = 's'`,
      );
      await repo.replaceScriptBucket(script(4));
      expect(
        await storage.executor.get(sql`
          SELECT runs, "agentUsd", "eventRuns" FROM automation_savings_daily WHERE "jobId" = 's'`),
      ).toEqual({ runs: 4, agentUsd: 0, eventRuns: 0 });
    });

    test("countWorkflowRunsSince counts runs started at or after the bound", async () => {
      expect(await repo.countWorkflowRunsSince("w1", "2026-11-20T00:00:00.000Z")).toBe(0);
    });
    test("window reads: markers, buckets by day, one-job reads, link sums", async () => {
      await repo.markDay("2026-11-18", "workflow", 1, "2026-11-19T00:00:00.000Z");
      await repo.markDay("2026-11-19", "workflow", 1, "2026-11-21T00:00:00.000Z");
      await repo.markDay("2026-11-20", "workflow", 1, "2026-11-20T12:00:00.000Z");
      await repo.markDay("2026-11-18", "script", 1, "2026-11-22T00:00:00.000Z");
      const summary = await repo.summarizeDayMarkers("workflow", 1, "2026-11-19", "2026-11-20");
      expect(Number(summary?.n)).toBe(1);
      expect(summary?.at).toBe("2026-11-21T00:00:00.000Z");
      expect(
        Number((await repo.summarizeDayMarkers("script", 1, "2026-11-19", "2026-11-20"))?.n),
      ).toBe(0);

      const wf = (day: string, jobId: string, jobKey: string, runs: number) => ({
        day,
        jobId,
        jobKey,
        jobName: jobKey.toUpperCase(),
        facts: { runs },
        modelVersion: 1,
        computedAt: "2026-11-21T00:00:00.000Z",
      });
      await repo.upsertWorkflowBucket(wf("2026-11-20", "w1", "a", 1));
      await repo.upsertWorkflowBucket(wf("2026-11-19", "w1", "a", 2));
      await repo.upsertWorkflowBucket(wf("2026-11-19", "w2", "b", 3));
      expect(await repo.findWorkflowJobKey("w2", "2026-11-19", "2026-11-20")).toEqual({
        jobKey: "b",
      });
      expect(await repo.findWorkflowJobKey("w2", "2026-11-20", "2026-11-20")).toBeNull();
      const filter = { kind: "workflow" as const, modelVersion: 1 };
      const counts = await repo.countBucketsByDay(filter, "2026-11-01", "2026-11-30");
      expect(counts.map((c) => ({ day: c.day, n: Number(c.n) }))).toEqual([
        { day: "2026-11-19", n: 2 },
        { day: "2026-11-20", n: 1 },
      ]);
      const rows = await repo.listBuckets<{ day: string; jobId: string; runs: number }>(
        filter,
        ["day", "jobId", "runs"],
        "2026-11-01",
        "2026-11-30",
      );
      // Oldest day first.
      expect(rows.map((r) => r.day)).toEqual(["2026-11-19", "2026-11-19", "2026-11-20"]);
      const one = await repo.listBuckets<{ day: string; runs: number }>(
        { ...filter, jobKey: "a" },
        ["day", "runs"],
        "2026-11-01",
        "2026-11-30",
      );
      expect(one).toEqual([
        { day: "2026-11-19", runs: 2 },
        { day: "2026-11-20", runs: 1 },
      ]);
      expect(
        await repo.listBuckets(
          { kind: "workflow", modelVersion: 2 },
          ["day"],
          "2026-11-01",
          "2026-11-30",
        ),
      ).toEqual([]);

      const link = (day: string, childJobId: string, n: number, actualUsd: number) => ({
        day,
        parentJobId: "w1",
        childKind: "workflow",
        childJobId,
        linkKind: "sub-workflow",
        n,
        actualUsd,
        keptUsd: 0,
        modelVersion: 1,
        computedAt: "2026-11-21T00:00:00.000Z",
      });
      await repo.replaceLink(link("2026-11-19", "w3", 4, 2));
      await repo.replaceLink(link("2026-11-20", "w3", 2, 1));
      await repo.replaceLink(link("2026-11-20", "w2", 1, 0));
      const sums = await repo.sumLinks("2026-11-19", "2026-11-20", 0.5, 1);
      expect(sums.map((r) => [r.childJobId, Number(r.n), Number(r.usd)])).toEqual([
        ["w2", 1, 0],
        ["w3", 4, 2],
      ]);
    });

    test("lookups on an empty swarm", async () => {
      expect(await repo.listWorkflows()).toEqual([]);
      expect(await repo.listWorkflowDefinitions([])).toEqual([]);
      expect(await repo.listWorkflowDefinitions(["nope"])).toEqual([]);
      expect(await repo.scriptNameExists("nope")).toBe(false);
      expect(await repo.workflowExists("nope")).toBe(false);
      expect(await repo.listScheduledScriptNames()).toEqual([]);
      expect(await repo.listScheduleTargets()).toEqual([]);
      expect(await repo.listScheduleTargets("nope")).toEqual([]);
      expect(await repo.sumSessionCostUsd("2026-01-01", "2027-01-01")).toBe(0);
      expect(await repo.sumScheduleSpend("2026-01-01", "2027-01-01")).toEqual([]);
      expect(await repo.sumScheduleSpend("2026-01-01", "2027-01-01", "s1")).toEqual([]);
    });

    // ---- live scans with rows (unordered unless stated: compared sorted) ----

    const T = (hms: string, day = "2026-11-20") => `${day}T${hms}Z`;
    const span = { start: T("00:00:00.000"), end: T("00:00:00.000", "2026-11-21") };
    const byJson = <R>(rows: R[]) =>
      [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    /** Seconds sums: SQLite's julianday difference is a float near the exact value. */
    const secs3 = (v: number | null) => (v === null ? null : Math.round(Number(v) * 1000) / 1000);

    const addWorkflow = (id: string) =>
      storage.executor.run(
        sql`INSERT INTO workflows (id, name, definition) VALUES (${id}, ${`wf-${id}`}, '{}')`,
      );
    const addRun = (
      id: string,
      workflowId: string,
      startedAt: string,
      triggerType: string,
      status: string,
      links: { parentStepId?: string; sourceStepId?: string } = {},
    ) =>
      storage.executor.run(sql`
        INSERT INTO workflow_runs (id, "workflowId", status, "startedAt", "triggerType", "parentStepId", "sourceStepId")
        VALUES (${id}, ${workflowId}, ${status}, ${startedAt}, ${triggerType}, ${links.parentStepId ?? null}, ${links.sourceStepId ?? null})`);
    const addStep = (
      id: string,
      runId: string,
      nodeId: string,
      nodeType: string,
      startedAt: string,
      finishedAt: string | null,
      output: string | null = null,
    ) =>
      storage.executor.run(sql`
        INSERT INTO workflow_run_steps (id, "runId", "nodeId", "nodeType", "startedAt", "finishedAt", output)
        VALUES (${id}, ${runId}, ${nodeId}, ${nodeType}, ${startedAt}, ${finishedAt}, ${output})`);
    const addTask = (
      id: string,
      createdAt: string,
      links: {
        workflowRunId?: string;
        parentTaskId?: string;
        sourceStepId?: string;
        sourceScriptRunId?: string;
        task?: string;
      } = {},
    ) =>
      storage.executor.run(sql`
        INSERT INTO agent_tasks (id, task, status, "createdAt", "lastUpdatedAt", "workflowRunId", "parentTaskId", "sourceStepId", "sourceScriptRunId")
        VALUES (${id}, ${links.task ?? "t"}, 'completed', ${createdAt}, ${createdAt}, ${links.workflowRunId ?? null},
          ${links.parentTaskId ?? null}, ${links.sourceStepId ?? null}, ${links.sourceScriptRunId ?? null})`);
    let costs = 0;
    const addAgent = () =>
      storage.executor.run(sql`
        INSERT INTO agents (id, name, "isLead", status, "createdAt", "lastUpdatedAt")
        VALUES ('a1', 'a1', ${false}, 'idle', ${T("00:00:00.000")}, ${T("00:00:00.000")})`);
    const addCost = (
      taskId: string | null,
      usd: number,
      ms: number,
      extra: {
        id?: string;
        model?: string;
        numTurns?: number | null;
        breakdown?: string | null;
        createdAt?: string;
      } = {},
    ) => {
      costs += 1;
      return storage.executor.run(sql`
        INSERT INTO session_costs (id, "sessionId", "taskId", "agentId", "totalCostUsd", "durationMs", model, "numTurns", "modelBreakdown", "createdAt")
        VALUES (${extra.id ?? `c${costs}`}, ${`s${costs}`}, ${taskId}, 'a1', ${usd}, ${ms}, ${extra.model ?? "m"},
          ${extra.numTurns ?? null}, ${extra.breakdown ?? null}, ${extra.createdAt ?? T("09:00:00.000")})`);
    };
    const addScriptRun = (
      id: string,
      scriptName: string | null,
      startedAt: string,
      finishedAt: string | null,
      extra: { apiEndpointId?: string; output?: string; sourceStepId?: string } = {},
    ) =>
      storage.executor.run(sql`
        INSERT INTO script_runs (id, "agentId", "scriptName", source, "startedAt", "finishedAt", "apiEndpointId", output, "sourceStepId")
        VALUES (${id}, 'a1', ${scriptName}, 'x', ${startedAt}, ${finishedAt}, ${extra.apiEndpointId ?? null},
          ${extra.output ?? null}, ${extra.sourceStepId ?? null})`);

    /** w1 runs: r1/r2 share a minute, r3 starts a child run, r4 is skipped, r6 starts a child; r0/r5 fall outside the span. */
    const seedWorkflowRuns = async () => {
      await addAgent();
      for (const w of ["w1", "w2", "w3"]) await addWorkflow(w);
      await addRun("r0", "w1", T("23:59:59.999", "2026-11-19"), "schedule", "completed");
      await addRun("r1", "w1", T("10:00:00.000"), "schedule", "completed");
      await addRun("r2", "w1", T("10:00:30.000"), "schedule", "completed");
      await addRun("r3", "w1", T("11:00:00.000"), "manual", "failed");
      await addRun("r4", "w1", T("12:00:00.000"), "schedule", "skipped");
      await addRun("r5", "w1", T("00:00:00.000", "2026-11-21"), "schedule", "completed");
      await addRun("r6", "w1", T("13:00:00.000"), "schedule", "completed");
      await addStep(
        "s1a",
        "r1",
        "fetch",
        "swarm-script",
        T("10:00:00.000"),
        T("10:00:02.500"),
        '{"tasks":["x"]}',
      );
      await addStep(
        "s1b",
        "r1",
        "think",
        "system-one-route",
        T("10:00:03.000"),
        null,
        '{"usage":{"input_tokens":100}}',
      );
      await addStep(
        "s1c",
        "r1",
        "report",
        "raw-llm",
        T("10:00:04.000"),
        T("10:00:05.000"),
        '{"result":{"summary":{"jevCostUsd":0.25},"cost":{"clairicUsd":0.5}}}',
      );
      await addStep("s1d", "r1", "agent", "agent-task", T("10:00:05.000"), T("10:01:05.000"));
      await addStep("s2a", "r2", "fetch", "swarm-script", T("10:00:30.000"), T("10:00:31.000"));
      await addStep("s2b", "r2", "FETCH#1", "swarm-script", T("10:00:32.000"), null, '"one"');
      await addStep("s2c", "r2", "fetchy", "swarm-script", T("10:00:33.000"), null, '"two"');
      await addStep(
        "s2d",
        "r2",
        "llm",
        "raw-llm",
        T("10:00:34.000"),
        T("10:00:34.250"),
        '{"result":"hello"}',
      );
      await addStep("s3a", "r3", "spawn", "sub-workflow", T("11:00:00.000"), T("11:05:00.000"));
      await addStep("s6a", "r6", "spawn", "sub-workflow", T("13:00:00.000"), null);
      await addStep(
        "s0a",
        "r0",
        "fetch",
        "swarm-script",
        T("23:59:59.999", "2026-11-19"),
        null,
        "{}",
      );
      await addRun("c1", "w2", T("11:00:05.000"), "manual", "completed", { parentStepId: "s3a" });
      await addRun("c2", "w2", T("13:00:05.000"), "manual", "completed", { parentStepId: "s6a" });
      await addRun("c3", "w3", T("10:00:06.000"), "api", "completed", { sourceStepId: "s1a" });
      await addRun("c4", "w3", T("10:00:06.000", "2026-11-22"), "api", "completed", {
        sourceStepId: "s1a",
      });
      await addTask("t1", T("10:00:05.000"), { workflowRunId: "r1" });
      await addTask("t1b", T("10:00:05.000"), { workflowRunId: "r1" });
      await addTask("t4", T("12:00:01.000"), { workflowRunId: "r4" });
      await addTask("t5", T("00:00:01.000", "2026-11-21"), { workflowRunId: "r5" });
      await addTask("f1", T("10:02:00.000"), {
        parentTaskId: "t1",
        task: "Worker task completed: ok",
      });
      await addTask("f2", T("10:03:00.000"), {
        parentTaskId: "t1",
        task: "worker task FAILED: no",
      });
      await addTask("f3", T("10:04:00.000"), { parentTaskId: "t1", task: "Other follow-up" });
      await addTask("st1", T("10:00:02.000"), { sourceStepId: "s1a" });
      await addTask("st0", T("23:00:00.000", "2026-11-19"), { sourceStepId: "s1a" });
      await addCost("t1", 1.5, 1000);
      await addCost("t1", 0.5, 500);
      await addCost("t4", 1, 100);
      await addCost("f1", 0.25, 10);
      await addCost("f2", 0.5, 10);
      await addCost("f3", 9, 10);
      await addScriptRun("sr1", "fetcher", T("10:00:01.000"), T("10:00:02.000"), {
        sourceStepId: "s1a",
      });
      await addScriptRun("sr2", null, T("10:00:01.500"), null, { sourceStepId: "s1a" });
      await addScriptRun("sr3", "fetcher", T("10:00:01.000", "2026-11-21"), null, {
        sourceStepId: "s1a",
      });
    };

    test("workflow scans: run counts, triggers, scheduled effects, effect steps", async () => {
      await seedWorkflowRuns();
      expect(await repo.countWorkflowRunsInSpan("w1", span)).toBe(5);
      expect(await repo.countWorkflowRunsInSpan("w2", span)).toBe(2);
      const triggers = await repo.workflowRunsByTrigger("w1", span, "minute");
      expect(byJson(triggers.map((r) => ({ ...r, n: Number(r.n) })))).toEqual([
        { d: "2026-11-20T10:00", tt: "schedule", st: "completed", n: 2 },
        { d: "2026-11-20T11:00", tt: "manual", st: "failed", n: 1 },
        { d: "2026-11-20T12:00", tt: "schedule", st: "skipped", n: 1 },
        { d: "2026-11-20T13:00", tt: "schedule", st: "completed", n: 1 },
      ]);
      const daily = await repo.workflowRunsByTrigger("w1", span, "day");
      expect(byJson(daily.map((r) => ({ ...r, n: Number(r.n) })))).toEqual([
        { d: "2026-11-20", tt: "manual", st: "failed", n: 1 },
        { d: "2026-11-20", tt: "schedule", st: "completed", n: 3 },
        { d: "2026-11-20", tt: "schedule", st: "skipped", n: 1 },
      ]);
      // r1 created a task, r6 a child run; r4 is skipped, r2 had no effect.
      const scheduled = await repo.workflowScheduledEffectRuns("w1", span, "minute");
      expect(byJson(scheduled.map((r) => ({ ...r, n: Number(r.n) })))).toEqual([
        { d: "2026-11-20T10:00", n: 1 },
        { d: "2026-11-20T13:00", n: 1 },
      ]);
      // Effect runs of any trigger: r1, r4 (tasks), r3, r6 (child runs).
      const effects = await repo.workflowEffectSteps("w1", span, "day");
      expect(byJson(effects.map((r) => ({ ...r, n: Number(r.n) })))).toEqual(
        byJson([
          { d: "2026-11-20", nid: null, n: 4 },
          { d: "2026-11-20", nid: "agent", n: 1 },
          { d: "2026-11-20", nid: "fetch", n: 1 },
          { d: "2026-11-20", nid: "report", n: 1 },
          { d: "2026-11-20", nid: "spawn", n: 2 },
          { d: "2026-11-20", nid: "think", n: 1 },
        ]),
      );
      expect(await repo.workflowEffectSteps("w3", span, "day")).toEqual([]);
    });

    test("workflow scans: step facts, agent and follow-up spend", async () => {
      await seedWorkflowRuns();
      const facts = await repo.workflowStepFacts("w1", span, "minute");
      expect(
        byJson(
          facts.map((r) => ({
            d: r.d,
            nid: r.nid,
            n: Number(r.n),
            secs: secs3(r.secs),
            itok: r.itok === null ? null : Number(r.itok),
            rchars: r.rchars === null ? null : Number(r.rchars),
            jev: r.jev,
            clairic: r.clairic,
          })),
        ),
      ).toEqual(
        byJson([
          {
            d: "2026-11-20T10:00",
            nid: "fetch",
            n: 2,
            secs: 3.5,
            itok: null,
            rchars: null,
            jev: null,
            clairic: null,
          },
          {
            d: "2026-11-20T10:00",
            nid: "think",
            n: 1,
            secs: 0,
            itok: 100,
            rchars: null,
            jev: null,
            clairic: null,
          },
          {
            d: "2026-11-20T10:00",
            nid: "report",
            n: 1,
            secs: 1,
            itok: null,
            rchars: 57,
            jev: 0.25,
            clairic: 0.5,
          },
          {
            d: "2026-11-20T10:00",
            nid: "agent",
            n: 1,
            secs: 0,
            itok: null,
            rchars: null,
            jev: null,
            clairic: null,
          },
          {
            d: "2026-11-20T10:00",
            nid: "FETCH#1",
            n: 1,
            secs: 0,
            itok: null,
            rchars: null,
            jev: null,
            clairic: null,
          },
          {
            d: "2026-11-20T10:00",
            nid: "fetchy",
            n: 1,
            secs: 0,
            itok: null,
            rchars: null,
            jev: null,
            clairic: null,
          },
          {
            d: "2026-11-20T10:00",
            nid: "llm",
            n: 1,
            secs: 0.25,
            itok: null,
            rchars: 5,
            jev: null,
            clairic: null,
          },
          {
            d: "2026-11-20T11:00",
            nid: "spawn",
            n: 1,
            secs: 0,
            itok: null,
            rchars: null,
            jev: null,
            clairic: null,
          },
          {
            d: "2026-11-20T13:00",
            nid: "spawn",
            n: 1,
            secs: 0,
            itok: null,
            rchars: null,
            jev: null,
            clairic: null,
          },
        ]),
      );
      const spend = await repo.workflowAgentSpend("w1", span, "day");
      expect(
        spend.map((r) => ({ d: r.d, tasks: Number(r.tasks), usd: r.usd, ms: Number(r.ms) })),
      ).toEqual([{ d: "2026-11-20", tasks: 3, usd: 3, ms: 1600 }]);
      const byMinute = await repo.workflowAgentSpend("w1", span, "minute");
      expect(
        byJson(
          byMinute.map((r) => ({
            d: r.d,
            tasks: Number(r.tasks),
            usd: r.usd,
            ms: r.ms === null ? null : Number(r.ms),
          })),
        ),
      ).toEqual([
        { d: "2026-11-20T10:00", tasks: 2, usd: 2, ms: 1500 },
        { d: "2026-11-20T12:00", tasks: 1, usd: 1, ms: 100 },
      ]);
      // Follow-ups match "Worker task completed/failed" in any ASCII case.
      expect(await repo.workflowFollowupSpend("w1", span, "day")).toEqual([
        { d: "2026-11-20", fup: 0.75 },
      ]);
      expect(await repo.workflowFollowupSpend("w2", span, "day")).toEqual([]);
    });

    test("workflow scans: links, owned tasks and dispatch steps", async () => {
      await seedWorkflowRuns();
      const counted = <R extends { n: number }>(rows: R[]) =>
        byJson(rows.map((r) => ({ ...r, n: Number(r.n) })));
      expect(counted(await repo.subWorkflowLinks(span))).toEqual([{ pid: "w1", cid: "w2", n: 2 }]);
      expect(counted(await repo.stampedWorkflowLinks(span))).toEqual([
        { pid: "w1", cid: "w3", n: 1 },
      ]);
      expect(counted(await repo.stampedScriptLinks(span, "(inline)"))).toEqual([
        { pid: "w1", nm: "(inline)", n: 1 },
        { pid: "w1", nm: "fetcher", n: 1 },
      ]);
      expect(byJson(await repo.listStepTasks(span))).toEqual([{ pid: "w1", id: "st1" }]);
      expect(byJson(await repo.listNodeTasks(span))).toEqual([
        { pid: "w1", id: "t1" },
        { pid: "w1", id: "t1b" },
        { pid: "w1", id: "t4" },
      ]);
      // The node itself or its foreach iterations (`node#i`, ASCII case-insensitive); with output only.
      expect(byJson(await repo.listDispatchSteps("w1", span, ["fetch"]))).toEqual([
        { id: "s1a", sa: T("10:00:00.000"), fa: T("10:00:02.500"), output: '{"tasks":["x"]}' },
        { id: "s2b", sa: T("10:00:32.000"), fa: T("10:00:32.000"), output: '"one"' },
      ]);
      expect(await repo.listDispatchSteps("w1", span, [])).toEqual([]);
    });

    test("script scans: await counts, dispatchers, runs by name, effect runs", async () => {
      await addAgent();
      const addScript = (
        id: string,
        name: string,
        scope: string,
        source: string,
        isScratch = false,
      ) =>
        storage.executor.run(sql`
          INSERT INTO scripts (id, name, scope, "scopeId", source, description, intent, "signatureJson", "contentHash", "isScratch")
          VALUES (${id}, ${name}, ${scope}, ${scope === "agent" ? "a1" : null}, ${source}, 'd', 'i', '{}', ${id}, ${isScratch})`);
      await addScript("p1", "a", "global", "await z; workflow_trigger()");
      await addScript("p2", "a", "agent", "await x; await y; return 1");
      await addScript("p3", "b", "agent", "await q; task_send()", true);
      await addScript("p4", "c", "agent", "SENDTASK()");
      await addScript("p5", "d", "agent", "nothing to see");
      const awaits = await repo.listScriptAwaitCounts(["a", "b", "c", "d"]);
      // Global rows come last.
      expect(awaits).toHaveLength(4);
      expect(awaits[3]).toEqual({ name: "a", aw: 1 });
      expect(byJson(awaits.slice(0, 3))).toEqual([
        { name: "a", aw: 2 },
        { name: "c", aw: 0 },
        { name: "d", aw: 0 },
      ]);
      expect(await repo.listScriptAwaitCounts([])).toEqual([]);
      expect((await repo.listDispatchingScripts(["a", "b", "c", "d"])).sort()).toEqual(["a", "c"]);
      expect(await repo.listDispatchingScripts([])).toEqual([]);

      await addScriptRun("sr1", "fetcher", T("10:00:00.000"), T("10:00:01.500"), {
        apiEndpointId: "e1",
      });
      await addScriptRun("sr2", "fetcher", T("10:00:40.000"), null, { output: '{"created":"u1"}' });
      await addScriptRun("sr3", null, T("11:00:00.000"), T("11:00:02.000"));
      await addScriptRun("sr4", "other", T("00:00:00.000", "2026-11-21"), null, { output: "u2" });
      await addScriptRun("sr5", "fetcher", T("23:00:00.000", "2026-11-19"), null, { output: "u1" });
      const runs = (
        rows: { d: string; nm: string; n: number; api: number; secs: number | null }[],
      ) =>
        byJson(
          rows.map((r) => ({
            d: r.d,
            nm: r.nm,
            n: Number(r.n),
            api: Number(r.api),
            secs: secs3(r.secs),
          })),
        );
      expect(runs(await repo.scriptRunsByName(span, "day", { inlineName: "(inline)" }))).toEqual([
        { d: "2026-11-20", nm: "(inline)", n: 1, api: 0, secs: 2 },
        { d: "2026-11-20", nm: "fetcher", n: 2, api: 1, secs: 1.5 },
      ]);
      expect(
        runs(
          await repo.scriptRunsByName(span, "minute", {
            scriptName: "(inline)",
            inlineName: "(inline)",
          }),
        ),
      ).toEqual([{ d: "2026-11-20T11:00", nm: "(inline)", n: 1, api: 0, secs: 2 }]);
      expect(
        await repo.countScriptRuns(span, { scriptName: "fetcher", inlineName: "(inline)" }),
      ).toBe(2);

      // Stamped tasks link exactly (up to 20 minutes after the span); u1 is
      // named in the output of a dispatcher run started within 20 minutes before it.
      await addTask("k1", T("10:00:05.000"), { sourceScriptRunId: "sr1" });
      await addTask("k3", T("00:10:00.000", "2026-11-21"), { sourceScriptRunId: "sr3" });
      await addTask("k9", T("00:30:00.000", "2026-11-21"), { sourceScriptRunId: "sr3" });
      await addTask("u1", T("10:00:50.000"));
      await addTask("u2", T("00:00:10.000", "2026-11-21"));
      const effects = (rows: { d: string; nm: string; api: number; n: number }[]) =>
        byJson(rows.map((r) => ({ d: r.d, nm: r.nm, api: Number(r.api), n: Number(r.n) })));
      expect(
        effects(
          await repo.scriptEffectRuns(span, "day", { inlineName: "(inline)" }, [
            "fetcher",
            "other",
          ]),
        ),
      ).toEqual([
        { d: "2026-11-20", nm: "(inline)", api: 0, n: 1 },
        { d: "2026-11-20", nm: "fetcher", api: 0, n: 1 },
        { d: "2026-11-20", nm: "fetcher", api: 1, n: 1 },
      ]);
      expect(
        effects(await repo.scriptEffectRuns(span, "minute", { inlineName: "(inline)" }, [])),
      ).toEqual([
        { d: "2026-11-20T10:00", nm: "fetcher", api: 1, n: 1 },
        { d: "2026-11-20T11:00", nm: "(inline)", api: 0, n: 1 },
      ]);
      expect(
        effects(
          await repo.scriptEffectRuns(
            span,
            "day",
            { scriptName: "(inline)", inlineName: "(inline)" },
            [],
          ),
        ),
      ).toEqual([{ d: "2026-11-20", nm: "(inline)", api: 0, n: 1 }]);
    });

    test("task trees: own and below per root, depth-bounded, spend summed", async () => {
      await addAgent();
      await addTask("r1", T("01:00:00.000"));
      await addTask("k1", T("01:00:01.000"), { parentTaskId: "r1" });
      await addTask("k2", T("01:00:02.000"), { parentTaskId: "k1" });
      // Owned by a workflow step: not part of the tree.
      await addTask("k3", T("01:00:03.000"), { parentTaskId: "r1", sourceStepId: "x" });
      // Another root: its own tree, not below r1.
      await addTask("r2", T("01:00:04.000"), { parentTaskId: "r1" });
      await addTask("k4", T("01:00:05.000"), { parentTaskId: "r2" });
      await addCost("r1", 1, 10);
      await addCost("k1", 2, 20);
      await addCost("k2", 0.25, 5);
      await addCost("k2", 0.25, 5);
      await addCost("k3", 100, 100);
      const trees = async (depth: number) =>
        byJson(
          (await repo.listTaskTrees(["r1", "r2"], depth)).map((t) => ({
            root: t.root,
            below: Number(t.below),
            n: Number(t.n),
            usd: t.usd,
            ms: t.ms === null ? null : Number(t.ms),
          })),
        );
      expect(await trees(20)).toEqual([
        { root: "r1", below: 0, n: 1, usd: 1, ms: 10 },
        { root: "r1", below: 1, n: 2, usd: 2.5, ms: 30 },
        { root: "r2", below: 0, n: 1, usd: null, ms: null },
        { root: "r2", below: 1, n: 1, usd: null, ms: null },
      ]);
      expect(await trees(1)).toEqual([
        { root: "r1", below: 0, n: 1, usd: 1, ms: 10 },
        { root: "r1", below: 1, n: 1, usd: 2, ms: 20 },
        { root: "r2", below: 0, n: 1, usd: null, ms: null },
        { root: "r2", below: 1, n: 1, usd: null, ms: null },
      ]);
      expect(await repo.listTaskTrees([], 20)).toEqual([]);
    });

    test("calibration sessions: per-model breakdown entries, keyset pages by id", async () => {
      await addAgent();
      const reader = <T>(text: string, params: (string | number | null)[]) =>
        storage.client.query<T>(text, params as never);
      const entry = (model: string, inputTokens: number) => ({
        model,
        inputTokens,
        outputTokens: 5,
        cacheWriteTokens: 2,
        costUsd: 0.5,
      });
      const at = T("09:00:00.000");
      await addCost(null, 1, 100, {
        id: "c1",
        numTurns: 2,
        breakdown: JSON.stringify([entry("m", 10), entry("o", 99)]),
      });
      await addCost(null, 1, 100, { id: "c2", numTurns: 2, breakdown: "not json" });
      await addCost(null, 1, 100, {
        id: "c3",
        numTurns: 0,
        breakdown: JSON.stringify([entry("m", 1)]),
      });
      await addCost(null, 2, 200, {
        id: "c4",
        numTurns: 30,
        breakdown: JSON.stringify({ m: entry("m", 7) }),
      });
      await addCost(null, 1, 100, {
        id: "c5",
        model: "o",
        numTurns: 2,
        breakdown: JSON.stringify([entry("m", 1)]),
      });
      await addCost(null, 1, 100, {
        id: "c6",
        numTurns: 31,
        breakdown: JSON.stringify([entry("m", 1)]),
      });
      await addCost(null, 3, 300, {
        id: "c0",
        numTurns: 1,
        breakdown: JSON.stringify([entry("m", 3)]),
      });
      await addCost(null, 1, 100, {
        id: "c7",
        numTurns: 2,
        breakdown: JSON.stringify([entry("m", 1)]),
        createdAt: span.end,
      });
      await addCost(null, 1, 100, { id: "c8", numTurns: 2, breakdown: null, createdAt: at });
      const row = (
        id: string,
        turns: number,
        durationMs: number,
        inputTokens: number,
        totalCostUsd: number,
      ) => ({
        id,
        turns,
        durationMs,
        inputTokens,
        outputTokens: 5,
        cacheReadTokens: null,
        cacheWriteTokens: 2,
        costUsd: 0.5,
        totalCostUsd,
      });
      const first = await repo.listCalibrationSessions("m", span, 30, "", 2, reader);
      expect(first).toEqual([row("c0", 1, 300, 3, 3), row("c1", 2, 100, 10, 1)]);
      expect(await repo.listCalibrationSessions("m", span, 30, "c1", 2, reader)).toEqual([
        row("c4", 30, 200, 7, 2),
      ]);
    });

    test("scans run through a given reader, rendered for the engine", async () => {
      const texts: string[] = [];
      const reader = <T>(text: string, params: (string | number | null)[]) => {
        texts.push(text);
        return storage.client.query<T>(text, params as never);
      };
      const span = { start: "2026-11-20T00:00:00.000Z", end: "2026-11-21T00:00:00.000Z" };
      expect(await repo.countWorkflowRunsInSpan("w1", span, reader)).toBe(0);
      expect(
        await repo.countScriptRuns(span, { scriptName: "s", inlineName: "(inline)" }, reader),
      ).toBe(0);
      expect(await repo.countScriptRuns(span, { inlineName: "(inline)" })).toBe(0);
      expect(texts).toHaveLength(2);
      expect(texts[1]?.startsWith("SELECT count(*) n FROM script_runs")).toBe(true);
      expect(await repo.workflowRunsByTrigger("w1", span, "minute", reader)).toEqual([]);
      expect(await repo.workflowStepFacts("w1", span, "day", reader)).toEqual([]);
      expect(await repo.workflowEffectSteps("w1", span, "day", reader)).toEqual([]);
      expect(await repo.scriptRunsByName(span, "day", { inlineName: "(inline)" }, reader)).toEqual(
        [],
      );
      expect(
        await repo.scriptEffectRuns(span, "day", { inlineName: "(inline)" }, ["s"], reader),
      ).toEqual([]);
      expect(await repo.listScriptAwaitCounts(["s"], reader)).toEqual([]);
      expect(await repo.listDispatchingScripts(["s"], reader)).toEqual([]);
      expect(await repo.subWorkflowLinks(span, reader)).toEqual([]);
      expect(await repo.listStepTasks(span, reader)).toEqual([]);
      expect(await repo.listDispatchSteps("w1", span, ["n1"], reader)).toEqual([]);
      expect(await repo.listUnstampedRuns(["x"], reader)).toEqual([]);
      expect(await repo.listUnstampedTasks(["x"], reader)).toEqual([]);
      // Each root forms its own tree, even without a task row.
      const trees = await repo.listTaskTrees(["r1"], 20, reader);
      expect(trees.map((t) => [t.root, Number(t.below), Number(t.n)])).toEqual([["r1", 0, 1]]);
      expect(await repo.listClaudePrices(["m"], Date.now(), reader)).toEqual([]);
      expect(await repo.listTierSessions("m", span, 30, "", 10, reader)).toEqual([]);
      expect(await repo.listCalibrationSessions("m", span, 30, "", 10, reader)).toEqual([]);
    });
  });
}
