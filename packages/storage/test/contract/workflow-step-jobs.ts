import { describe, expect, test } from "bun:test";
import { sql } from "../../src";
import type { ContractEngine } from "./env";

export function workflowStepJobsContract(engine: ContractEngine): void {
  describe(`workflow step jobs [${engine.name}]`, () => {
    test("claims parked attempts, fences owners, recovers leases and cancels without payloads", async () => {
      const storage = await engine.fresh();
      try {
        const now = "2026-11-25T10:00:00.000Z";
        const later = "2026-11-25T10:01:00.000Z";
        const end = "2026-11-25T10:02:00.000Z";
        await storage.executor.run(sql`INSERT INTO workflows (id,name,definition,triggers,enabled,"createdAt","lastUpdatedAt")
          VALUES ('w','w','{"nodes":[]}','[]',${true},${now},${now})`);
        await storage.executor.run(sql`INSERT INTO workflow_runs (id,"workflowId",status,"triggerData",context,"startedAt","lastUpdatedAt")
          VALUES ('r','w','running','{}','{}',${now},${now})`);
        await storage.executor.run(sql`INSERT INTO workflow_run_steps (id,"runId","nodeId","nodeType",status,"retryCount")
          VALUES ('s','r','n','swarm-script','running',0)`);
        const repo = storage.repos.workflowStepJobs;
        const row = {
          id: "j",
          runId: "r",
          stepId: "s",
          attempt: 0,
          kind: "step-script",
          status: "queued" as const,
          ownerId: null,
          leaseExpiresAt: null,
          error: null,
          createdAt: now,
          updatedAt: now,
          createdBy: null,
          updatedBy: null,
        };
        await repo.insert(row);
        expect(await repo.get("j")).toEqual(row);
        expect(await repo.claim("a", now, later)).toBeNull();
        expect(await repo.listClaimable(now)).toEqual([]);
        await storage.executor.run(
          sql`UPDATE workflow_run_steps SET status = 'waiting' WHERE id = 's'`,
        );
        for (let attempt = 1; attempt <= 101; attempt++)
          await repo.insert({ ...row, id: `abandoned-${attempt}`, attempt });
        expect((await repo.listClaimable(now)).map((job) => job.id)).toEqual(["j"]);
        expect((await repo.claim("a:old", now, later))?.ownerId).toBe("a:old");
        expect(await repo.claim("b", now, later)).toBeNull();
        expect(await repo.settle("j", "b", now, "completed", null)).toBe(false);
        expect(await repo.renew("j", "b", now, end)).toBe(false);
        expect((await repo.claim("b", later, end))?.ownerId).toBe("b");
        expect(await repo.settle("j", "a:old", later, "completed", null)).toBe(false);
        await expect(
          storage.transaction(async () => {
            expect(await repo.settle("j", "b", later, "completed", null)).toBe(true);
            throw new Error("rollback checkpoint");
          }),
        ).rejects.toThrow("rollback checkpoint");
        expect((await repo.get("j"))?.status).toBe("running");
        expect((await repo.cancelRun("r", later)).length).toBe(102);
        expect(await repo.settle("j", "b", later, "completed", null)).toBe(false);
        expect(await repo.listOpen("r")).toEqual([]);
        expect((await repo.get("j"))?.status).toBe("cancelled");
        expect(await repo.cancelRun("r", end)).toEqual([]);
      } finally {
        await engine.release(storage);
      }
    },30000);
  });
}
