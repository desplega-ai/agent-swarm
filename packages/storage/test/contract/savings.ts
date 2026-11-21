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

    test("countWorkflowRunsSince counts runs started at or after the bound", async () => {
      expect(await repo.countWorkflowRunsSince("w1", "2026-11-20T00:00:00.000Z")).toBe(0);
    });
  });
}
