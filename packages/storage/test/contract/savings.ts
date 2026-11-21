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
