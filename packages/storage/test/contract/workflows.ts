import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Storage, sql, type WorkflowsRepository } from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const T2 = "2026-11-21T12:00:00.000Z";

export function workflowsContract(engine: ContractEngine): void {
  describe(`workflows repository [${engine.name}]`, () => {
    let storage: Storage;
    let repo: WorkflowsRepository;

    beforeEach(async () => {
      storage = await engine.fresh();
      repo = storage.repos.workflows;
    });
    afterEach(async () => {
      await engine.release(storage);
    });

    const workflow = (
      id: string,
      o: { enabled?: boolean; triggers?: string; lastUpdatedAt?: string } = {},
    ) =>
      storage.executor.run(sql`
        INSERT INTO workflows (id, name, definition, triggers, enabled, "createdAt", "lastUpdatedAt")
        VALUES (${id}, ${id}, '{"nodes":[]}', ${o.triggers ?? "[]"}, ${o.enabled ?? true}, ${T0},
          ${o.lastUpdatedAt ?? T0})`);

    const run = (
      id: string,
      o: {
        workflowId?: string;
        status?: string;
        parentStepId?: string;
        attempt?: number;
        definitionHash?: string;
      } = {},
    ) =>
      storage.executor.run(sql`
        INSERT INTO workflow_runs (id, "workflowId", status, "triggerData", context, "startedAt",
          "lastUpdatedAt", "parentStepId", "parentStepAttempt", principal, "triggeredByAgentId",
          "definitionHash")
        VALUES (${id}, ${o.workflowId ?? "w1"}, ${o.status ?? "running"}, '{"a":1}', '{"big":true}',
          ${T0}, ${T0}, ${o.parentStepId ?? null}, ${o.attempt ?? 0}, '{"kind":"user"}', 'agent-1',
          ${o.definitionHash ?? null})`);

    const step = (
      id: string,
      runId: string,
      o: {
        nodeId?: string;
        nodeType?: string;
        status?: string;
        startedAt?: string;
        retryCount?: number;
        nextRetryAt?: string | null;
        finishedAt?: string | null;
        error?: string | null;
      } = {},
    ) =>
      storage.executor.run(sql`
        INSERT INTO workflow_run_steps (id, "runId", "nodeId", "nodeType", status, input, output,
          "startedAt", "retryCount", "nextRetryAt", "finishedAt", error)
        VALUES (${id}, ${runId}, ${o.nodeId ?? id}, ${o.nodeType ?? "agent-task"},
          ${o.status ?? "running"}, '{"in":1}', '{"out":1}', ${o.startedAt ?? T0},
          ${o.retryCount ?? 0}, ${o.nextRetryAt ?? null}, ${o.finishedAt ?? null}, ${o.error ?? null})`);

    const stepRow = (id: string) =>
      storage.executor.get<Record<string, unknown>>(
        sql`SELECT * FROM workflow_run_steps WHERE id = ${id}`,
      );
    const runRow = (id: string) =>
      storage.executor.get<Record<string, unknown>>(
        sql`SELECT * FROM workflow_runs WHERE id = ${id}`,
      );

    test("run summary and principal come back in the stored value shape", async () => {
      await workflow("w1");
      await run("r1");
      const summary = await repo.getRunSummary("r1");
      expect(summary).toEqual({
        id: "r1",
        workflowId: "w1",
        status: "running",
        triggerType: "manual",
        triggerData: '{"a":1}',
        error: null,
        created_by: null,
        startedAt: T0,
        lastUpdatedAt: T0,
        finishedAt: null,
        parentStepId: null,
        parentStepAttempt: 0,
      });
      expect(await repo.getRunPrincipal("r1")).toEqual({
        principal: '{"kind":"user"}',
        triggeredByAgentId: "agent-1",
      });
      expect(await repo.getRunSummary("missing")).toBeNull();
      expect(await repo.getRunPrincipal("missing")).toBeNull();
      expect(await repo.getRunStatus("r1")).toBe("running");
      expect(await repo.getRunStatus("missing")).toBeNull();
    });

    test("listRunSummariesByIds orders by id", async () => {
      await workflow("w1");
      await run("r2");
      await run("r1");
      await run("r3");
      expect((await repo.listRunSummariesByIds(["r3", "r1", "r2"])).map((r) => r.id)).toEqual([
        "r1",
        "r2",
        "r3",
      ]);
    });

    test("listStepsSlim orders by startedAt, ties in insertion order, without input", async () => {
      await workflow("w1");
      await run("r1");
      await step("s-b", "r1", { startedAt: T1 });
      await step("s-z", "r1", { startedAt: T0 });
      await step("s-a", "r1", { startedAt: T1 });
      const rows = await repo.listStepsSlim("r1");
      expect(rows.map((r) => r.id)).toEqual(["s-z", "s-b", "s-a"]);
      expect(rows[0]).not.toHaveProperty("input");
      expect(rows[0]).not.toHaveProperty("output_replay");
      expect(rows[0]).toMatchObject({ output: '{"out":1}', retryCount: 0, nextPort: null });
    });

    test("lineage walks up the parent links, nearest first, bounded by depth", async () => {
      await workflow("w1");
      await workflow("w2");
      await workflow("w3");
      await run("root", { workflowId: "w1", status: "cancelled" });
      await step("root-s", "root");
      await run("mid", { workflowId: "w2", parentStepId: "root-s" });
      await step("mid-s", "mid");
      await run("leaf", { workflowId: "w3", parentStepId: "mid-s" });
      expect(await repo.listRunLineage("leaf", 32)).toEqual([
        { id: "leaf", status: "running", parentStepId: "mid-s", depth: 0 },
        { id: "mid", status: "running", parentStepId: "root-s", depth: 1 },
        { id: "root", status: "cancelled", parentStepId: null, depth: 2 },
      ]);
      expect(await repo.listRunLineageWorkflowIds("leaf", 32)).toEqual(["w3", "w2", "w1"]);
      expect(await repo.listRunLineageWorkflowIds("leaf", 1)).toEqual(["w3", "w2"]);
      expect(await repo.listRunLineage("missing", 32)).toEqual([]);
    });

    test("listChildRunIds orders by parent run, step, then attempt", async () => {
      await workflow("w1");
      await run("pb");
      await run("pa");
      await step("pb-s", "pb");
      await step("pa-s2", "pa");
      await step("pa-s1", "pa");
      await run("c4", { parentStepId: "pb-s" });
      await run("c3", { parentStepId: "pa-s1", attempt: 1 });
      await run("c2", { parentStepId: "pa-s1", attempt: 0 });
      await run("c1", { parentStepId: "pa-s2" });
      expect(await repo.listChildRunIds(["pb", "pa"])).toEqual(["c1", "c2", "c3", "c4"]);
      expect(await repo.listChildRunIds(["c1"])).toEqual([]);
    });

    test("open-work probes", async () => {
      await workflow("w1");
      await run("done", { status: "completed" });
      await run("live", { status: "waiting" });
      expect(await repo.hasLiveRun(["done"])).toBe(false);
      expect(await repo.hasLiveRun(["done", "live"])).toBe(true);

      await step("s1", "done", { status: "completed" });
      expect(await repo.hasOpenStep(["done"])).toBe(false);
      await step("s2", "done", { status: "failed", nextRetryAt: T1 });
      expect(await repo.hasOpenStep(["done"])).toBe(true);

      expect(await repo.hasPendingApproval(["done"])).toBe(false);
      await storage.executor.run(sql`
        INSERT INTO approval_requests (id, title, questions, approvers, status, "workflowRunId")
        VALUES ('a1', 't', '[]', '{}', 'pending', 'done')`);
      expect(await repo.hasPendingApproval(["done"])).toBe(true);
    });

    test("tree cancel writes touch only open steps, queued retries and live runs", async () => {
      await workflow("w1");
      await run("r1");
      await run("r2", { status: "completed" });
      await step("p", "r1", { status: "pending" });
      await step("w", "r1", { status: "waiting" });
      await step("c", "r1", { status: "completed", finishedAt: T0 });
      await step("f", "r1", { status: "failed", nextRetryAt: T1, finishedAt: null });
      await step("g", "r1", { status: "failed", nextRetryAt: T1, finishedAt: T0 });
      await repo.cancelOpenStepsOfRuns(["r1"], "stop", T2);
      expect(await stepRow("p")).toMatchObject({
        status: "cancelled",
        error: "stop",
        finishedAt: T2,
      });
      expect(await stepRow("w")).toMatchObject({ status: "cancelled" });
      expect(await stepRow("c")).toMatchObject({ status: "completed", finishedAt: T0 });

      await repo.disarmRetriesOfRuns(["r1"], T2);
      expect(await stepRow("f")).toMatchObject({
        status: "failed",
        nextRetryAt: null,
        finishedAt: T2,
      });
      expect(await stepRow("g")).toMatchObject({ nextRetryAt: null, finishedAt: T0 });

      const cancelled = await repo.cancelLiveRuns(["r2", "r1"], "stop", T2);
      expect(cancelled).toEqual([{ id: "r1", workflowId: "w1" }]);
      expect(await runRow("r1")).toMatchObject({
        status: "cancelled",
        error: "stop",
        finishedAt: T2,
        lastUpdatedAt: T2,
      });
      expect(await runRow("r2")).toMatchObject({ status: "completed", error: null });
    });

    test("step attempt and execution state reads", async () => {
      await workflow("w1");
      await run("r1");
      await run("r2", { status: "completed" });
      await step("s1", "r1", { retryCount: 2 });
      await step("s2", "r2");
      await step("s3", "r1", { status: "waiting" });
      expect(await repo.getLiveStepAttemptRunId("s1", 2)).toBe("r1");
      expect(await repo.getLiveStepAttemptRunId("s1", 1)).toBeNull();
      expect(await repo.getLiveStepAttemptRunId("s2", 0)).toBeNull();
      expect(await repo.getLiveStepAttemptRunId("s3", 0)).toBeNull();
      expect(await repo.getStepExecutionState("s2")).toEqual({
        stepStatus: "running",
        runId: "r2",
        runStatus: "completed",
      });
      expect(await repo.getStepExecutionState("missing")).toBeNull();
      expect(await repo.getRunParent("s1")).toEqual({
        runId: "r1",
        workflowId: "w1",
        stepId: "s1",
        nodeId: "s1",
      });
      expect(await repo.getRunParent("missing")).toBeNull();
      await run("child", { parentStepId: "s1", attempt: 2 });
      expect(await repo.getChildRunId("s1", 2)).toBe("child");
      expect(await repo.getChildRunId("s1", 1)).toBeNull();
    });

    test("sub-workflow recovery reads keep step insertion order", async () => {
      await workflow("w1");
      await run("r1");
      await run("r-done", { status: "completed" });
      // Superseded row of node n1: only the newest row counts.
      await step("old", "r1", { nodeId: "n1", nodeType: "sub-workflow" });
      await step("z", "r1", { nodeId: "n2", nodeType: "sub-workflow" });
      await step("new", "r1", { nodeId: "n1", nodeType: "sub-workflow" });
      await step("other", "r1", { nodeId: "n3" });
      await step("done", "r-done", { nodeId: "n1", nodeType: "sub-workflow" });
      expect(await repo.listRunningSubWorkflowSteps()).toEqual([
        { stepId: "z", runId: "r1", nodeId: "n2" },
        { stepId: "new", runId: "r1", nodeId: "n1" },
      ]);

      await step("wb", "r1", { nodeId: "n4", nodeType: "sub-workflow", status: "waiting" });
      await step("wa", "r1", {
        nodeId: "n5",
        nodeType: "sub-workflow",
        status: "waiting",
        retryCount: 1,
      });
      await step("wc", "r1", { nodeId: "n6", nodeType: "sub-workflow", status: "waiting" });
      await run("c-live", { parentStepId: "wb" });
      await run("c-old", { parentStepId: "wa", attempt: 0, status: "running" });
      await run("c-ended", { parentStepId: "wc", status: "failed" });
      // wa: no child for its current attempt (1); wc: child ended; wb: child live.
      expect(await repo.listSettledChildRunParentStepIds()).toEqual(["wa", "wc"]);
      expect(await repo.listChildRunsOfWorkflow("w1")).toEqual([
        { id: "c-live", parentStepId: "wb" },
        { id: "c-old", parentStepId: "wa" },
        { id: "c-ended", parentStepId: "wc" },
      ]);
    });

    test("listRunIdsByStatus keeps insertion order", async () => {
      await workflow("w1");
      await run("r-b");
      await run("r-a");
      await run("r-c", { status: "waiting" });
      expect(await repo.listRunIdsByStatus("running")).toEqual(["r-b", "r-a"]);
    });

    test("foreach step inserts: prefix scan, count, idempotency-key conflict", async () => {
      await workflow("w1");
      await run("r1");
      const pending = (id: string, nodeId: string, key: string) => ({
        id,
        runId: "r1",
        nodeId,
        nodeType: "agent-task",
        startedAt: T1,
        input: '{"i":1}',
        idempotencyKey: key,
      });
      await repo.insertPendingStep(pending("s2", "fe#b", "k2"));
      await repo.insertPendingStep(pending("s1", "fe#a", "k1"));
      await repo.insertPendingStep(pending("s3", "fe#a", "k3"));
      await repo.insertPendingStep(pending("s4", "fex", "k4"));
      expect(await stepRow("s1")).toMatchObject({
        status: "pending",
        startedAt: T1,
        input: '{"i":1}',
        idempotencyKey: "k1",
        retryCount: 0,
      });
      expect(await repo.listStepNodeIdsWithPrefix("r1", "fe#")).toEqual(["fe#a", "fe#b"]);
      expect(await repo.countStepsForNode("r1", "fe#a")).toBe(2);
      expect(await repo.countStepsForNode("r1", "none")).toBe(0);
      expect(await repo.insertPendingStepIfNewKey(pending("s5", "fe#c", "k5"))).toBe(true);
      expect(await repo.insertPendingStepIfNewKey(pending("s6", "fe#c", "k5"))).toBe(false);
      expect(await stepRow("s6")).toBeNull();
    });

    test("fenced and conditional step writes", async () => {
      await workflow("w1");
      await run("r1");
      await run("r-done", { status: "completed" });
      await step("s1", "r1", { retryCount: 1 });
      await step("s2", "r-done");
      expect(await repo.holdsStepFence("r1", "s1", 1)).toBe(true);
      expect(await repo.holdsStepFence("r1", "s1", 0)).toBe(false);
      expect(await repo.holdsStepFence("r-done", "s2", 0)).toBe(false);

      expect(await repo.parkRunningStep("r-done", "s2")).toBe(false);
      expect(await repo.parkRunningStep("r1", "s1")).toBe(true);
      expect(await stepRow("s1")).toMatchObject({ status: "waiting" });
      expect(await repo.parkRunningStep("r1", "s1")).toBe(false);

      expect(await repo.transitionStepStatus("s1", "running", "pending")).toBe(false);
      expect(await repo.transitionStepStatus("s1", "waiting", "running")).toBe(true);
      expect(await stepRow("s1")).toMatchObject({ status: "running" });

      await step("q1", "r1", { status: "pending" });
      await step("q2", "r1", { status: "failed", nextRetryAt: T1 });
      await step("q3", "r1", { status: "failed" });
      expect(await repo.cancelQueuedStep("q1", "fail-fast", T2)).toBe(true);
      expect(await repo.cancelQueuedStep("q2", "fail-fast", T2)).toBe(true);
      expect(await repo.cancelQueuedStep("q3", "fail-fast", T2)).toBe(false);
      expect(await stepRow("q2")).toMatchObject({
        status: "cancelled",
        error: "fail-fast",
        finishedAt: T2,
        nextRetryAt: null,
      });
    });

    test("retry claims and drops", async () => {
      await workflow("w1");
      await run("r1");
      await step("f1", "r1", { status: "failed", nextRetryAt: T1, error: "boom" });
      await step("f2", "r1", { status: "failed", nextRetryAt: T1, error: "boom" });
      await step("f3", "r1", { status: "failed", nextRetryAt: T1, error: "boom" });
      await step("f4", "r1", { status: "failed", error: "boom" });

      await repo.dropStepRetry("r1", "f1", T2);
      expect(await stepRow("f1")).toMatchObject({
        status: "failed",
        nextRetryAt: null,
        finishedAt: T2,
        error: "boom",
      });
      expect(await repo.claimStepRetry("r1", "f1", false)).toBe(false);
      expect(await repo.claimStepRetry("r1", "f2", false)).toBe(true);
      expect(await stepRow("f2")).toMatchObject({
        status: "running",
        nextRetryAt: null,
        error: "boom",
      });
      expect(await repo.claimStepRetry("r1", "f3", true)).toBe(true);
      expect(await stepRow("f3")).toMatchObject({
        status: "pending",
        nextRetryAt: null,
        error: null,
      });
      expect(await repo.claimStepRetry("r1", "f4", true)).toBe(false);
      expect(await repo.claimStepRetry("other", "f3", true)).toBe(false);
    });

    test("listForeachFanoutCandidates orders by status, then insertion order", async () => {
      await workflow("w1");
      await run("r1");
      await run("r-done", { status: "failed" });
      await step("run-b", "r1", { nodeId: "fe#b", status: "running" });
      await step("pend-b", "r1", { nodeId: "fe#d", status: "pending" });
      await step("pend-a", "r1", { nodeId: "fe#c", status: "pending" });
      await step("hash-first", "r1", { nodeId: "#x", status: "pending" });
      await step("plain", "r1", { nodeId: "plain", status: "pending" });
      await step("done", "r1", { nodeId: "fe#e", status: "completed" });
      await step("ended-run", "r-done", { nodeId: "fe#f", status: "pending" });
      expect((await repo.listForeachFanoutCandidates()).map((r) => r.stepId)).toEqual([
        "pend-b",
        "pend-a",
        "run-b",
      ]);
      expect((await repo.listForeachFanoutCandidates())[0]).toEqual({
        runId: "r1",
        workflowId: "w1",
        stepId: "pend-b",
        nodeId: "fe#d",
        status: "pending",
      });
    });

    test("run definitions: first snapshot wins, unreferenced ones go", async () => {
      await workflow("w1");
      await repo.insertRunDefinition("h1", '{"v":1}', T0);
      await repo.insertRunDefinition("h1", '{"v":2}', T1);
      await repo.insertRunDefinition("h2", '{"v":3}', T0);
      await run("r1", { definitionHash: "h1" });
      await run("r2");
      expect(await repo.getRunDefinitionSnapshot("r1")).toBe('{"v":1}');
      expect(await repo.getRunDefinitionSnapshot("r2")).toBeNull();
      await repo.deleteUnreferencedRunDefinitions(["h1", "h2"]);
      await repo.deleteUnreferencedRunDefinitions([]);
      const left = await storage.executor.query<{ hash: string }>(
        sql`SELECT hash FROM workflow_run_definitions ORDER BY hash`,
      );
      expect(left.map((r) => r.hash)).toEqual(["h1"]);
    });

    test("idempotency records: one per scope, tombstoned on delete", async () => {
      const scope = {
        principal: "user:1",
        operation: "workflow.trigger",
        targetId: "w1",
        keyHash: "kh",
      };
      expect(await repo.findIdempotencyRecord(scope)).toBeNull();
      expect(await repo.idempotencyRecordExists(scope)).toBe(false);
      const record = {
        ...scope,
        id: "i1",
        requestFingerprint: "fp",
        workflowId: "w1",
        runId: "r1",
        responseStatus: 201,
        responseBody: '{"ok":true}',
        createdAt: T0,
        actor: null,
      };
      await repo.insertIdempotencyRecord(record);
      expect(await repo.findIdempotencyRecord(scope)).toEqual({
        requestFingerprint: "fp",
        responseStatus: 201,
        responseBody: '{"ok":true}',
        resourceDeletedAt: null,
      });
      expect(await repo.idempotencyRecordExists(scope)).toBe(true);
      expect(await repo.idempotencyRecordExists({ ...scope, targetId: "w2" })).toBe(false);
      await expect(repo.insertIdempotencyRecord({ ...record, id: "i2" })).rejects.toThrow();

      await repo.tombstoneIdempotencyRecords("w1", T1, "user-9");
      expect(await repo.findIdempotencyRecord(scope)).toEqual({
        requestFingerprint: "fp",
        responseStatus: 201,
        responseBody: null,
        resourceDeletedAt: T1,
      });
      // An existing tombstone keeps its first deletion time.
      await repo.tombstoneIdempotencyRecords("w1", T2, "user-9");
      expect((await repo.findIdempotencyRecord(scope))?.resourceDeletedAt).toBe(T1);
    });

    test("listEnabledByEventName filters event triggers, newest first, ties in insertion order", async () => {
      const ev = (name: string) => JSON.stringify([{ type: "event", eventName: name }]);
      await workflow("w-old", { triggers: ev("e1"), lastUpdatedAt: T0 });
      await workflow("w-tie-b", { triggers: ev("e1"), lastUpdatedAt: T1 });
      await workflow("w-tie-a", { triggers: ev("e1"), lastUpdatedAt: T1 });
      await workflow("w-off", { triggers: ev("e1"), enabled: false, lastUpdatedAt: T2 });
      await workflow("w-other", { triggers: ev("e2"), lastUpdatedAt: T2 });
      await workflow("w-twice", {
        triggers: JSON.stringify([
          { type: "event", eventName: "e1" },
          { type: "event", eventName: "e1" },
        ]),
        lastUpdatedAt: T0,
      });
      const rows = await repo.listEnabledByEventName("e1");
      expect(rows.map((r) => r.id)).toEqual(["w-tie-b", "w-tie-a", "w-old", "w-twice"]);
      expect(rows[0]).toMatchObject({ enabled: 1, definition: '{"nodes":[]}' });
    });
  });
}
