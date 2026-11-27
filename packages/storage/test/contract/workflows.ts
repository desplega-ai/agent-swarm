import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  jsonText,
  type NewApprovalRequest,
  type NewWaitState,
  type NewWorkflow,
  type Storage,
  sql,
  type WorkflowsRepository,
} from "../../src";
import type { ContractEngine } from "./env";

const T0 = "2026-11-21T10:00:00.000Z";
const T1 = "2026-11-21T11:00:00.000Z";
const T2 = "2026-11-21T12:00:00.000Z";
/** Before the wall clock, for the scans that compare with the current time. */
const PAST = "2020-01-01T00:00:00.000Z";

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
        VALUES (${id}, ${id}, '{"nodes":[]}', ${jsonText(o.triggers ?? "[]")}, ${o.enabled ?? true}, ${T0},
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

    const newWorkflow = (id: string, o: Partial<NewWorkflow> = {}): NewWorkflow => ({
      id,
      key: "shared/",
      name: id,
      description: null,
      definition: '{"nodes":[]}',
      triggers: "[]",
      cooldown: null,
      input: null,
      triggerSchema: null,
      params: "{}",
      requiredParams: "[]",
      requires: "[]",
      dir: null,
      vcsRepo: null,
      createdByAgentId: "agent-a",
      createdBy: null,
      enabled: true,
      ...o,
    });

    test("insertWorkflow returns the stored shape; updates set columns and lastUpdatedAt", async () => {
      const row = await repo.insertWorkflow(newWorkflow("w1", { enabled: false, dir: "/d" }));
      expect(row).toMatchObject({
        id: "w1",
        key: "shared/",
        enabled: 0,
        dir: "/d",
        vcs_repo: null,
        createdByAgentId: "agent-a",
        updatedByAgentId: "agent-a",
        params: "{}",
      });
      expect(await repo.findWorkflowById("w1")).toEqual(row);
      expect(await repo.findWorkflowById("missing")).toBeNull();
      const updated = await repo.updateWorkflowColumns(
        "w1",
        { enabled: true, cooldown: null, vcsRepo: "org/repo", updatedByAgentId: null },
        T2,
      );
      expect(updated).toMatchObject({
        enabled: 1,
        cooldown: null,
        vcs_repo: "org/repo",
        updatedByAgentId: null,
        lastUpdatedAt: T2,
        name: "w1",
      });
      expect(await repo.updateWorkflowColumns("missing", { name: "x" }, T2)).toBeNull();
    });

    test("listWorkflows filters and orders newest first, ties in insertion order", async () => {
      await workflow("b", { lastUpdatedAt: T1 });
      await workflow("a", { lastUpdatedAt: T1 });
      await workflow("old", { lastUpdatedAt: T0, enabled: false });
      await storage.executor.run(
        sql`UPDATE workflows SET "key" = 'shared/team/', description = 'Hello World' WHERE id = 'a'`,
      );
      expect((await repo.listWorkflows({})).map((r) => r.id)).toEqual(["b", "a", "old"]);
      expect((await repo.listWorkflows({ enabled: false })).map((r) => r.id)).toEqual(["old"]);
      expect((await repo.listWorkflows({ key: "shared/team/" })).map((r) => r.id)).toEqual(["a"]);
      expect((await repo.listWorkflows({ keyPattern: "SHARED/TEAM/%" })).map((r) => r.id)).toEqual([
        "a",
      ]);
      expect((await repo.listWorkflows({ textPattern: "%world%" })).map((r) => r.id)).toEqual([
        "a",
      ]);
      expect((await repo.listWorkflows({ textPattern: "%10\\%%" })).map((r) => r.id)).toEqual([]);
      expect((await repo.listWorkflows({ limit: 1 })).map((r) => r.id)).toEqual(["b"]);

      await run("r1", { workflowId: "b", status: "failed" });
      await storage.executor.run(sql`UPDATE workflow_runs SET "startedAt" = ${T1} WHERE id = 'r1'`);
      await run("r2", { workflowId: "b", status: "failed" });
      await run("r3", { workflowId: "a", status: "completed" });
      await storage.executor.run(sql`UPDATE workflow_runs SET "startedAt" = ${T2} WHERE id = 'r3'`);
      await run("r4", { workflowId: "a", status: "failed" });
      expect((await repo.listWorkflows({ lastRunStatus: "failed" })).map((r) => r.id)).toEqual([
        "b",
      ]);
      expect((await repo.listWorkflows({ consecutiveErrorsMin: 2 })).map((r) => r.id)).toEqual([
        "b",
      ]);
      expect((await repo.listWorkflows({ consecutiveErrorsMin: 1 })).map((r) => r.id)).toEqual([
        "b",
      ]);
    });

    test("listEnabledByScheduleId lists one row per matching trigger in insertion order", async () => {
      const sched = (ids: string[]) =>
        JSON.stringify(ids.map((scheduleId) => ({ type: "schedule", scheduleId })));
      await workflow("w-b", { triggers: sched(["s1", "s1"]), lastUpdatedAt: T2 });
      await workflow("w-a", { triggers: sched(["s1"]), lastUpdatedAt: T0 });
      await workflow("w-off", { triggers: sched(["s1"]), enabled: false });
      await workflow("w-other", { triggers: sched(["s2"]) });
      expect((await repo.listEnabledByScheduleId("s1")).map((r) => r.id)).toEqual([
        "w-b",
        "w-b",
        "w-a",
      ]);
    });

    test("workflow delete helpers remove steps, runs and the workflow", async () => {
      await workflow("w1");
      await workflow("w2");
      await repo.insertRunDefinition("hb", "{}", T0);
      await repo.insertRunDefinition("ha", "{}", T0);
      await run("r1", { workflowId: "w1", definitionHash: "hb" });
      await run("r2", { workflowId: "w1", definitionHash: "ha" });
      await run("r3", { workflowId: "w1", definitionHash: "hb" });
      await run("r4", { workflowId: "w2" });
      await step("s1", "r1");
      await step("s4", "r4");
      expect(await repo.listRunDefinitionHashesOfWorkflow("w1")).toEqual(["ha", "hb"]);
      await repo.deleteStepsOfWorkflow("w1");
      expect(await stepRow("s1")).toBeNull();
      expect(await stepRow("s4")).not.toBeNull();
      await repo.deleteRunsOfWorkflow("w1");
      expect(await runRow("r1")).toBeNull();
      expect(await runRow("r4")).not.toBeNull();
      await storage.executor.run(sql`DELETE FROM workflow_run_steps WHERE "runId" = 'r4'`);
      await storage.executor.run(sql`DELETE FROM workflow_runs WHERE id = 'r4'`);
      expect(await repo.deleteWorkflow("w2")).toBe(1);
      expect(await repo.deleteWorkflow("w2")).toBe(0);
    });

    test("run rows: insert, update, list pages, counts, latest", async () => {
      await workflow("w1");
      const row = await repo.insertRun({
        id: "r1",
        workflowId: "w1",
        triggerType: "api",
        startedAt: T0,
        triggerData: '{"t":1}',
        createdBy: null,
        parentStepId: null,
        parentStepAttempt: 0,
        triggeredByAgentId: "agent-1",
        definitionHash: null,
        sourceStepId: "step-x",
        principal: null,
      });
      expect(row).toMatchObject({
        id: "r1",
        status: "running",
        triggerType: "api",
        context: null,
        finishedAt: null,
        parentStepAttempt: 0,
      });
      expect(await repo.findRunById("r1")).toEqual(row);
      const updated = await repo.updateRunColumns(
        "r1",
        {
          status: "completed",
          context: "{}",
          context_replay: "sealed",
          finishedAt: T2,
          error: null,
        },
        T2,
      );
      expect(updated).toMatchObject({
        status: "completed",
        context: "{}",
        context_replay: "sealed",
        finishedAt: T2,
        lastUpdatedAt: T2,
      });

      for (const [id, startedAt, status] of [
        ["r2", T1, "failed"],
        ["r4", T1, "completed"],
        ["r3", T1, "completed"],
        ["r5", T2, "skipped"],
      ] as const) {
        await run(id, { status });
        await storage.executor.run(
          sql`UPDATE workflow_runs SET "startedAt" = ${startedAt}, "finishedAt" = ${startedAt} WHERE id = ${id}`,
        );
      }
      const all = await repo.listRuns("w1", { includeContext: false });
      expect(all.map((r) => r.id)).toEqual(["r5", "r4", "r3", "r2", "r1"]);
      expect(all[0]).not.toHaveProperty("context");
      expect((await repo.listRuns("w1", { includeContext: true }))[0]).toHaveProperty("context");
      expect(
        (await repo.listRuns("w1", { limit: 2, offset: 1, includeContext: false })).map(
          (r) => r.id,
        ),
      ).toEqual(["r4", "r3"]);
      expect(
        (await repo.listRuns("w1", { offset: 3, includeContext: false })).map((r) => r.id),
      ).toEqual(["r2", "r1"]);
      expect(
        (await repo.listRuns("w1", { status: "completed", includeContext: false })).map(
          (r) => r.id,
        ),
      ).toEqual(["r4", "r3", "r1"]);
      expect(await repo.countRuns("w1")).toBe(5);
      expect(await repo.countRuns("w1", "completed")).toBe(3);
      expect((await repo.lastSuccessfulRun("w1"))?.id).toBe("r1");
      expect((await repo.lastRunStart("w1"))?.status).not.toBe("skipped");
      expect(await repo.lastSuccessfulRun("missing")).toBeNull();
    });

    test("listStuckRuns: waiting steps of waiting runs whose task ended, by task creation", async () => {
      await workflow("w1");
      await run("r1", { status: "waiting" });
      await run("r2", { status: "running" });
      await step("s1", "r1", { status: "waiting" });
      await step("s2", "r1", { status: "waiting" });
      await step("s3", "r2", { status: "waiting" });
      const task = (id: string, stepId: string, status: string, createdAt: string) =>
        storage.executor.run(sql`
          INSERT INTO agent_tasks (id, task, status, "createdAt", "lastUpdatedAt", "workflowRunStepId", output)
          VALUES (${id}, 't', ${status}, ${createdAt}, ${createdAt}, ${stepId}, 'out')`);
      await task("t2", "s2", "completed", T1);
      await task("t1", "s1", "failed", T1);
      await task("t0", "s1", "in_progress", T0);
      await task("t3", "s3", "completed", T0);
      expect(await repo.listStuckRuns()).toEqual([
        {
          runId: "r1",
          stepId: "s2",
          nodeId: "s2",
          taskId: "t2",
          taskStatus: "completed",
          taskOutput: "out",
          workflowId: "w1",
        },
        {
          runId: "r1",
          stepId: "s1",
          nodeId: "s1",
          taskId: "t1",
          taskStatus: "failed",
          taskOutput: "out",
          workflowId: "w1",
        },
      ]);
    });

    test("step rows: insert, update, ordered reads", async () => {
      await workflow("w1");
      await run("r1");
      const inserted = await repo.insertRunningStep({
        id: "s1",
        runId: "r1",
        nodeId: "n1",
        nodeType: "agent-task",
        startedAt: T1,
        input: null,
        idempotencyKey: "k1",
      });
      expect(inserted).toMatchObject({
        id: "s1",
        status: "running",
        input: null,
        output: null,
        retryCount: 0,
        maxRetries: 0,
        nextRetryAt: null,
      });
      expect(await repo.findStepById("s1")).toEqual(inserted);
      expect(await repo.findStepByIdempotencyKey("k1")).toEqual(inserted);
      expect(await repo.findStepByIdempotencyKey("none")).toBeNull();
      const updated = await repo.updateStepColumns("s1", {
        status: "failed",
        output: "{}",
        output_replay: "sealed",
        retryCount: 2,
        nextRetryAt: T1,
        error: "boom",
        nextPort: "error",
      });
      expect(updated).toMatchObject({
        status: "failed",
        output: "{}",
        output_replay: "sealed",
        retryCount: 2,
        nextRetryAt: T1,
        error: "boom",
        nextPort: "error",
      });
      expect(await repo.updateStepColumns("missing", { status: "failed" })).toBeNull();

      await step("s3", "r1", { nodeId: "n1", startedAt: T1, status: "completed" });
      await step("s2", "r1", { nodeId: "n2", startedAt: T0, status: "completed" });
      await step("s4", "r1", { nodeId: "n1", startedAt: T0, status: "completed" });
      expect((await repo.listSteps("r1")).map((r) => r.id)).toEqual(["s2", "s4", "s1", "s3"]);
      expect((await repo.listSteps("r1"))[0]).toHaveProperty("input");
      expect(await repo.listCompletedStepNodeIds("r1")).toEqual(["n1", "n2", "n1"]);
      expect((await repo.latestStepForNode("r1", "n1"))?.id).toBe("s3");
      expect((await repo.lastInsertedStepForNode("r1", "n1"))?.id).toBe("s4");
      expect(await repo.latestStepForNode("r1", "none")).toBeNull();
      expect(await repo.hasCompletedStepInsertedAfter("r1", ["n2"], "s3")).toBe(true);
      expect(await repo.hasCompletedStepInsertedAfter("r1", ["n2"], "s2")).toBe(false);
      expect(await repo.hasCompletedStepInsertedAfter("r1", ["n1", "n9"], "s2")).toBe(true);
    });

    test("listDueRetrySteps: due retries of retryable runs, by nextRetryAt then insertion", async () => {
      await workflow("w1");
      await run("r1", { status: "failed" });
      await run("r2", { status: "cancelled" });
      await step("late", "r1", { status: "failed", nextRetryAt: T2 });
      await step("b", "r1", { status: "failed", nextRetryAt: T1 });
      await step("a", "r1", { status: "failed", nextRetryAt: T1 });
      await step("first", "r1", { status: "failed", nextRetryAt: T0 });
      await step("dead", "r2", { status: "failed", nextRetryAt: T0 });
      await step("none", "r1", { status: "failed" });
      expect((await repo.listDueRetrySteps(T1)).map((r) => r.id)).toEqual(["first", "b", "a"]);
    });

    test("versions: unique per workflow, newest first", async () => {
      await workflow("w1");
      const v1 = await repo.insertVersion({
        id: "v1",
        workflowId: "w1",
        version: 1,
        snapshot: '{"name":"a"}',
        changedByAgentId: null,
      });
      expect(v1).toMatchObject({ id: "v1", version: 1, snapshot: '{"name":"a"}' });
      expect(typeof v1?.createdAt).toBe("string");
      await repo.insertVersion({
        id: "v2",
        workflowId: "w1",
        version: 2,
        snapshot: "{}",
        changedByAgentId: "agent-1",
      });
      expect((await repo.listVersions("w1")).map((v) => v.version)).toEqual([2, 1]);
      expect((await repo.getVersion("w1", 2))?.changedByAgentId).toBe("agent-1");
      expect(await repo.getVersion("w1", 3)).toBeNull();
      await expect(
        repo.insertVersion({
          id: "v3",
          workflowId: "w1",
          version: 2,
          snapshot: "{}",
          changedByAgentId: null,
        }),
      ).rejects.toThrow();
    });

    const approval = (id: string, o: Partial<NewApprovalRequest> = {}): NewApprovalRequest => ({
      id,
      title: "t",
      questions: '[{"q":1},{"q":2}]',
      workflowRunId: null,
      workflowRunStepId: null,
      sourceTaskId: null,
      approvers: '{"policy":"any"}',
      status: "pending",
      resolutionReason: null,
      resolvedAt: null,
      timeoutSeconds: null,
      expiresAt: null,
      notificationChannels: null,
      createdBy: null,
      now: T0,
      ...o,
    });

    test("approval insert, lookups and conditional settles", async () => {
      await workflow("w1");
      await run("r1", { status: "waiting" });
      await step("s1", "r1", { status: "waiting" });
      const row = await repo.insertApproval(
        approval("a1", { workflowRunId: "r1", workflowRunStepId: "s1", timeoutSeconds: 60 }),
      );
      expect(row).toMatchObject({
        id: "a1",
        status: "pending",
        responses: null,
        approvals: null,
        timeoutSeconds: 60,
        createdAt: T0,
        updatedAt: T0,
        cancellationNotificationClaims: null,
      });
      expect(await repo.findApprovalById("a1")).toEqual(row);
      await repo.insertApproval(approval("a0", { workflowRunStepId: "s1" }));
      expect((await repo.findApprovalByStepId("s1"))?.id).toBe("a1");

      const resolution = {
        status: "approved",
        responses: "sealed",
        approvals: null,
        resolvedBy: "u1",
        resolutionReason: null,
        now: T1,
      };
      // The step is no longer waiting: an actionable resolve refuses.
      await storage.executor.run(
        sql`UPDATE workflow_run_steps SET status = 'running' WHERE id = 's1'`,
      );
      expect(await repo.resolveApproval("a1", resolution, true)).toBeNull();
      await storage.executor.run(
        sql`UPDATE workflow_run_steps SET status = 'waiting' WHERE id = 's1'`,
      );
      await repo.recordApprovalVotes("a1", '[{"v":1}]', T0);
      const resolved = await repo.resolveApproval("a1", resolution, true);
      expect(resolved).toMatchObject({
        status: "approved",
        responses: "sealed",
        approvals: '[{"v":1}]',
        resolvedBy: "u1",
        resolvedAt: T1,
        updatedAt: T1,
      });
      expect(await repo.resolveApproval("a1", resolution, false)).toBeNull();
      expect(await repo.recordApprovalVotes("a1", "[]", T2)).toBe(false);
      expect(await repo.cancelApproval("a1", "late", null, T2)).toBeNull();
      expect(await repo.cancelApproval("a0", "stop", "u2", T2)).toMatchObject({
        status: "cancelled",
        resolutionReason: "stop",
        resolvedBy: "u2",
        resolvedAt: T2,
      });
    });

    test("pendingApprovalStats counts pending, oldest and overdue", async () => {
      expect(await repo.pendingApprovalStats(T1)).toEqual({
        pending: 0,
        oldestCreatedAt: null,
        overdue: 0,
      });
      await repo.insertApproval(approval("late", { expiresAt: T0, now: T1 }));
      await repo.insertApproval(approval("open", { now: T0 }));
      await repo.insertApproval(approval("future", { expiresAt: T2, now: T1 }));
      await repo.insertApproval(
        approval("done", { status: "approved", now: "2026-11-21T09:00:00.000Z" }),
      );
      expect(await repo.pendingApprovalStats(T1)).toEqual({
        pending: 3,
        oldestCreatedAt: T0,
        overdue: 1,
      });
    });

    test("run cancels and cancelled lists keep insertion order", async () => {
      await repo.insertApproval(approval("b", { workflowRunId: "r1", workflowRunStepId: "s1" }));
      await repo.insertApproval(approval("a", { workflowRunId: "r1", workflowRunStepId: "s1" }));
      await repo.insertApproval(approval("done", { workflowRunId: "r1", status: "approved" }));
      const cancelled = await repo.cancelPendingApprovalsOfRun("r1", "stop", T1);
      expect(cancelled.map((r) => r.id).sort()).toEqual(["a", "b"]);
      expect(cancelled[0]).toMatchObject({ status: "cancelled", resolutionReason: "stop" });
      expect((await repo.listCancelledApprovalsOfRun("r1")).map((r) => r.id)).toEqual(["b", "a"]);
      expect((await repo.listCancelledApprovalsOfStep("s1")).map((r) => r.id)).toEqual(["b", "a"]);
    });

    test("notification claims only on settled requests; channels; notified cancelled list", async () => {
      await repo.insertApproval(approval("p"));
      await repo.insertApproval(approval("x", { status: "approved" }));
      await repo.insertApproval(
        approval("c2", { status: "cancelled", workflowRunId: "r1", notificationChannels: "[2]" }),
      );
      await repo.insertApproval(
        approval("c1", { status: "cancelled", workflowRunId: "r1", notificationChannels: "[1]" }),
      );
      await repo.insertApproval(approval("c0", { status: "cancelled", workflowRunId: "r1" }));
      expect(await repo.findSettledApproval("p", true)).toBeNull();
      expect(await repo.findSettledApproval("x", false)).toBeNull();
      expect((await repo.findSettledApproval("x", true))?.id).toBe("x");
      await repo.setApprovalNotificationClaims("x", '{"k":"delivered"}', T1, false);
      expect(await repo.getApprovalNotificationClaims("x")).toEqual({ claims: null });
      await repo.setApprovalNotificationClaims("x", '{"k":"delivered"}', T1, true);
      expect(await repo.getApprovalNotificationClaims("x")).toEqual({
        claims: '{"k":"delivered"}',
      });
      await repo.setApprovalNotificationClaims("p", "{}", T1, true);
      expect(await repo.getApprovalNotificationClaims("p")).toEqual({ claims: null });
      expect(await repo.getApprovalNotificationClaims("missing")).toBeNull();
      await repo.setApprovalNotificationChannels("p", '[{"channel":"slack"}]', T2);
      expect(await repo.findApprovalById("p")).toMatchObject({
        notificationChannels: '[{"channel":"slack"}]',
        updatedAt: T2,
      });
      await repo.setApprovalNotificationClaims("c1", '{"a":1}', T1, false);
      expect(await repo.listCancelledNotifiedApprovals(["r1", "r9"])).toEqual([
        { id: "c2", notificationChannels: "[2]", claims: null },
        { id: "c1", notificationChannels: "[1]", claims: '{"a":1}' },
      ]);
    });

    test("approval lists: newest first with ties in insertion order, filters, summaries", async () => {
      await repo.insertApproval(approval("old", { now: T0 }));
      await repo.insertApproval(approval("tie-b", { now: T1, workflowRunId: "r1" }));
      await repo.insertApproval(approval("tie-a", { now: T1, status: "approved" }));
      await repo.insertApproval(approval("new", { now: T2, questions: "[]" }));
      expect((await repo.listApprovals({ limit: 10 })).map((r) => r.id)).toEqual([
        "new",
        "tie-b",
        "tie-a",
        "old",
      ]);
      expect((await repo.listApprovals({ limit: 2 })).map((r) => r.id)).toEqual(["new", "tie-b"]);
      expect((await repo.listApprovals({ status: "pending", limit: 10 })).map((r) => r.id)).toEqual(
        ["new", "tie-b", "old"],
      );
      expect(
        (await repo.listApprovals({ status: "pending", workflowRunId: "r1", limit: 10 })).map(
          (r) => r.id,
        ),
      ).toEqual(["tie-b"]);
      const summaries = await repo.listApprovalSummaries({ limit: 10 });
      expect(summaries.map((r) => [r.id, r.questionCount])).toEqual([
        ["new", 0],
        ["tie-b", 2],
        ["tie-a", 2],
        ["old", 2],
      ]);
      expect(summaries[0]).not.toHaveProperty("questions");
      expect(summaries[0]).toMatchObject({ status: "pending", created_by: null, createdAt: T2 });
    });

    test("approval lists put a NULL createdAt last; a non-array questions value counts 0", async () => {
      await repo.insertApproval(approval("no-date", { now: T2 }));
      await repo.insertApproval(approval("dated", { now: T0, questions: '{"q":1}' }));
      await storage.executor.run(
        sql`UPDATE approval_requests SET "createdAt" = NULL WHERE id = 'no-date'`,
      );
      expect((await repo.listApprovals({ limit: 10 })).map((r) => r.id)).toEqual([
        "dated",
        "no-date",
      ]);
      expect(
        (await repo.listApprovalSummaries({ limit: 10 })).map((r) => [r.id, r.questionCount]),
      ).toEqual([
        ["dated", 0],
        ["no-date", 2],
      ]);
    });

    test("lastSuccessfulRun skips a completed run with no finishedAt", async () => {
      await workflow("w1");
      await run("r-done", { status: "completed" });
      await run("r-null", { status: "completed" });
      await storage.executor.run(
        sql`UPDATE workflow_runs SET "finishedAt" = ${T1} WHERE id = 'r-done'`,
      );
      expect((await repo.lastSuccessfulRun("w1"))?.id).toBe("r-done");
    });

    test("deadline scans, votes and task approvals", async () => {
      await repo.insertApproval(approval("late", { expiresAt: T1 }));
      await repo.insertApproval(approval("e-b", { expiresAt: T0 }));
      await repo.insertApproval(approval("e-a", { expiresAt: T0 }));
      await repo.insertApproval(approval("future", { expiresAt: "2099-01-01T00:00:00.000Z" }));
      await repo.insertApproval(approval("gone", { expiresAt: T0, status: "approved" }));
      await repo.insertApproval(approval("s-b", { now: T1 }));
      await repo.insertApproval(approval("s-a", { now: T0 }));
      expect((await repo.listExpiredPendingApprovals(T2)).map((r) => r.id)).toEqual([
        "e-b",
        "e-a",
        "late",
      ]);
      expect((await repo.listStalePendingApprovals(T2)).map((r) => r.id)).toEqual(["s-a", "s-b"]);
      expect(await repo.listPendingApprovalVotes(["s-b", "gone", "e-a"])).toEqual([
        { id: "e-a", approvers: '{"policy":"any"}', approvals: null },
        { id: "s-b", approvers: '{"policy":"any"}', approvals: null },
      ]);
      await storage.executor.run(sql`
        INSERT INTO agent_tasks (id, task, status, "createdAt", "lastUpdatedAt")
        VALUES ('t1', 't', 'pending', ${T0}, ${T0}), ('t2', 't', 'pending', ${T0}, ${T0})`);
      await repo.insertApproval(approval("q-z", { sourceTaskId: "t1", now: T0 }));
      await repo.insertApproval(approval("q-a", { sourceTaskId: "t2", now: T0 }));
      await repo.insertApproval(approval("q-new", { sourceTaskId: "t1", now: T1 }));
      await repo.insertApproval(approval("q-done", { sourceTaskId: "t1", status: "approved" }));
      expect(await repo.listPendingApprovalsForTasks(["t1", "t2"])).toEqual([
        { id: "q-a", status: "pending", sourceTaskId: "t2", title: "t" },
        { id: "q-z", status: "pending", sourceTaskId: "t1", title: "t" },
        { id: "q-new", status: "pending", sourceTaskId: "t1", title: "t" },
      ]);
    });

    test("listStuckApprovalRuns: answered or overdue requests of waiting steps", async () => {
      await workflow("w1");
      await run("r1", { status: "waiting" });
      await run("r2", { status: "running" });
      await step("s-b", "r1", { status: "waiting" });
      await step("s-a", "r1", { status: "waiting" });
      await step("s-c", "r1", { status: "waiting" });
      await step("s-r", "r2", { status: "waiting" });
      await repo.insertApproval(approval("a-a", { workflowRunStepId: "s-a", status: "timeout" }));
      await repo.insertApproval(
        approval("a-b", { workflowRunStepId: "s-b", responses: null, expiresAt: PAST }),
      );
      await repo.insertApproval(
        approval("a-c", { workflowRunStepId: "s-c", expiresAt: "2099-01-01T00:00:00.000Z" }),
      );
      await repo.insertApproval(approval("a-r", { workflowRunStepId: "s-r", status: "approved" }));
      expect(await repo.listStuckApprovalRuns()).toEqual([
        {
          runId: "r1",
          stepId: "s-b",
          nodeId: "s-b",
          workflowId: "w1",
          approvalId: "a-b",
          approvalStatus: "pending",
          approvalResponses: null,
          expiresAt: PAST,
        },
        {
          runId: "r1",
          stepId: "s-a",
          nodeId: "s-a",
          workflowId: "w1",
          approvalId: "a-a",
          approvalStatus: "timeout",
          approvalResponses: null,
          expiresAt: null,
        },
      ]);
    });

    const wait = (id: string, o: Partial<NewWaitState> = {}): NewWaitState => ({
      id,
      workflowRunId: "r1",
      workflowRunStepId: `step-${id}`,
      mode: "event",
      wakeUpAt: null,
      eventName: null,
      eventFilter: null,
      expiresAt: null,
      eventScope: "run",
      now: T0,
      ...o,
    });

    test("wait states: insert, lookups, conditional resolve", async () => {
      const row = await repo.insertWaitState(
        wait("w1", { eventName: "e", eventFilter: '{"a":1}', eventScope: "global" }),
      );
      expect(row).toMatchObject({
        id: "w1",
        status: "pending",
        eventFilter: '{"a":1}',
        eventScope: "global",
        firedPayload: null,
        resolvedAt: null,
        createdAt: T0,
      });
      expect(await repo.findWaitStateById("w1")).toEqual(row);
      await repo.insertWaitState(wait("w2", { workflowRunStepId: "step-w1" }));
      expect((await repo.findWaitStateByStepId("step-w1"))?.id).toBe("w1");
      expect(await repo.resolveWaitState("w1", "fired", '{"p":1}', T1)).toMatchObject({
        status: "fired",
        firedPayload: '{"p":1}',
        resolvedAt: T1,
        updatedAt: T1,
      });
      expect(await repo.resolveWaitState("w1", "timeout", null, T2)).toBeNull();
    });

    test("wait scans: due, event names, by event", async () => {
      const future = "2099-01-01T00:00:00.000Z";
      await repo.insertWaitState(wait("t-due", { mode: "time", wakeUpAt: PAST }));
      await repo.insertWaitState(wait("t-later", { mode: "time", wakeUpAt: future }));
      await repo.insertWaitState(wait("e-due", { eventName: "b", expiresAt: PAST }));
      await repo.insertWaitState(wait("e-open", { eventName: "a" }));
      await repo.insertWaitState(wait("e-r2", { eventName: "a", workflowRunId: "r2" }));
      await repo.insertWaitState(wait("e-fired", { eventName: "c", expiresAt: T0 }));
      await repo.resolveWaitState("e-fired", "fired", null, T1);
      expect((await repo.listDueWaitStates()).map((r) => r.id)).toEqual(["t-due", "e-due"]);
      expect(await repo.listPendingEventWaitNames()).toEqual(["a", "b"]);
      expect((await repo.listPendingWaitsByEvent("a")).map((r) => r.id)).toEqual([
        "e-open",
        "e-r2",
      ]);
      expect((await repo.listPendingWaitsByEvent("a", "r2")).map((r) => r.id)).toEqual(["e-r2"]);
    });

    test("listStuckWaitRuns: fired, timed out or overdue waits of waiting wait steps", async () => {
      await workflow("w1");
      await run("r1", { status: "waiting" });
      await step("s-b", "r1", { status: "waiting", nodeType: "wait" });
      await step("s-a", "r1", { status: "waiting", nodeType: "wait" });
      await step("s-c", "r1", { status: "waiting", nodeType: "wait" });
      await step("s-x", "r1", { status: "waiting", nodeType: "agent-task" });
      await repo.insertWaitState(wait("wa", { workflowRunStepId: "s-a" }));
      await repo.resolveWaitState("wa", "timeout", null, T1);
      await repo.insertWaitState(
        wait("wb", { workflowRunStepId: "s-b", mode: "time", wakeUpAt: PAST }),
      );
      await repo.insertWaitState(
        wait("wc", { workflowRunStepId: "s-c", expiresAt: "2099-01-01T00:00:00.000Z" }),
      );
      await repo.insertWaitState(wait("wx", { workflowRunStepId: "s-x", expiresAt: PAST }));
      expect(
        (await repo.listStuckWaitRuns()).map((r) => [r.stepId, r.waitId, r.waitStatus]),
      ).toEqual([
        ["s-b", "wb", "pending"],
        ["s-a", "wa", "timeout"],
      ]);
    });

    test("findWorkflowIdByName finds by exact name", async () => {
      await workflow("wf-a");
      expect(await repo.findWorkflowIdByName("wf-a")).toBe("wf-a");
      expect(await repo.findWorkflowIdByName("WF-A")).toBeNull();
    });

    test("preflight: enabled rows, setup failure runs in a window, failed run insert", async () => {
      await workflow("wf-b");
      await workflow("wf-off", { enabled: false });
      await workflow("wf-a");
      const rows = await repo.listEnabledPreflightRows();
      expect(rows.map((r) => [r.id, r.kind])).toEqual([
        ["wf-b", "workflow"],
        ["wf-a", "workflow"],
      ]);

      const start = "2026-11-21T00:00:00.000Z";
      const end = "2026-11-22T00:00:00.000Z";
      expect(await repo.findFirstTopLevelSetupFailureRunId("wf-a", start, end)).toBeNull();
      await repo.insertFailedRun({
        id: "r2",
        workflowId: "wf-a",
        triggerType: "manual",
        triggerData: null,
        error: "NEEDS_SETUP: slack",
        createdBy: null,
        now: "2026-11-21T12:00:00.000Z",
      });
      await repo.insertFailedRun({
        id: "r1",
        workflowId: "wf-a",
        triggerType: "manual",
        triggerData: '{"a":1}',
        error: "needs_setup: github",
        createdBy: null,
        now: "2026-11-21T11:00:00.000Z",
      });
      await repo.insertFailedRun({
        id: "r-old",
        workflowId: "wf-a",
        triggerType: "manual",
        triggerData: null,
        error: "needs_setup: x",
        createdBy: null,
        now: "2026-11-20T11:00:00.000Z",
      });
      expect(await repo.findRunById("r1")).toMatchObject({
        status: "failed",
        triggerData: '{"a":1}',
        error: "needs_setup: github",
        startedAt: "2026-11-21T11:00:00.000Z",
        finishedAt: "2026-11-21T11:00:00.000Z",
        parentStepId: null,
      });
      // LIKE folds ASCII case, as SQLite's built-in LIKE does.
      expect(await repo.findFirstTopLevelSetupFailureRunId("wf-a", start, end)).toBe("r1");
      expect(await repo.hasOtherSetupFailureRun("wf-a", "r1", start, end)).toBe(true);
      expect(
        await repo.hasOtherSetupFailureRun("wf-a", "r1", start, "2026-11-21T12:00:00.000Z"),
      ).toBe(false);
      expect(await repo.hasOtherSetupFailureRun("wf-b", "x", start, end)).toBe(false);
    });

    test("countCompletedRunsAll counts completed runs of every workflow", async () => {
      expect(await repo.countCompletedRunsAll()).toBe(0);
      await workflow("wa");
      await workflow("wb");
      await run("r1", { workflowId: "wa", status: "completed" });
      await run("r2", { workflowId: "wb", status: "completed" });
      await run("r3", { workflowId: "wb", status: "failed" });
      expect(await repo.countCompletedRunsAll()).toBe(2);
    });
  });
}
