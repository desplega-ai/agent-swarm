// Workflow engine, async executors: wait (time, run-scoped event, global event, timeout),
// agent-task, foreach over agent-tasks, sub-workflow and human-in-the-loop, all parked
// at once in one run that fans out, then released one by one from outside.
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  approvalsForRun,
  createWorkflow,
  getRunDetail,
  outputOf,
  registerWorker,
  respondApproval,
  stepOf,
  triggerWorkflow,
  type WorkflowDef,
  waitForApproval,
  waitForRun,
  waitForStep,
} from "./workflow-helpers";

export const workflowEngineAsyncNodes: Scenario = {
  name: "workflow-engine-async-nodes",
  order: 320,
  async run(ctx) {
    const marker = `async-${ctx.nonce}`;
    const workerId = await registerWorker(ctx, "wf-async");

    // The simulated worker settles every workflow task the engine pins to it.
    const sim = await ctx.startAgent({
      agentId: workerId,
      onTask: ({ taskId, task }) => ({
        status: "completed",
        output: JSON.stringify({ handled: String(task.task ?? ""), by: taskId }),
      }),
    });

    // Child workflow for the sub-workflow node. Its triggerSchema gates the inputs.
    const childId = await createWorkflow(
      ctx,
      "wf-async-child",
      {
        nodes: [
          {
            id: "n-child",
            type: "script",
            config: { runtime: "bash", script: "echo child-$0", args: ["{{trigger.value}}"] },
          },
        ],
      },
      {
        triggerSchema: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "string" } },
        },
      },
      workerId,
    );

    const approvalQuestions = [
      { id: "go", type: "approval", label: `Proceed with ${marker}?` },
      { id: "why", type: "text", label: "Why?", required: false },
    ];
    const definition: WorkflowDef = {
      nodes: [
        {
          id: "n-start",
          type: "property-match",
          config: { conditions: [{ field: "trigger.kind", op: "eq", value: "async" }] },
          next: [
            "n-wait-time",
            "n-wait-run",
            "n-wait-global",
            "n-wait-timeout",
            "n-agent",
            "n-foreach",
            "n-sub",
            "n-hitl",
          ],
        },
        {
          id: "n-wait-time",
          type: "wait",
          config: { mode: "time", durationMs: 1000 },
          next: "n-after-time",
        },
        {
          id: "n-after-time",
          type: "script",
          config: { runtime: "bash", script: "echo after-time" },
        },
        {
          id: "n-wait-run",
          type: "wait",
          config: {
            mode: "event",
            eventName: `e2e.run.${ctx.nonce}`,
            filter: { kind: "go" },
            scope: "run",
            timeoutMs: 120_000,
          },
          next: { event: "n-after-run", timeout: "n-run-timeout" },
        },
        {
          id: "n-after-run",
          type: "script",
          config: { runtime: "bash", script: "echo after-run" },
        },
        {
          id: "n-run-timeout",
          type: "script",
          config: { runtime: "bash", script: "echo timeout" },
        },
        {
          id: "n-wait-global",
          type: "wait",
          config: {
            mode: "event",
            eventName: `e2e.global.${ctx.nonce}`,
            filter: `(payload) => payload.release === '${ctx.nonce}' && payload.n > 1`,
            scope: "global",
          },
          next: { event: "n-after-global" },
        },
        {
          id: "n-after-global",
          type: "script",
          config: { runtime: "bash", script: "echo after-global" },
        },
        {
          id: "n-wait-timeout",
          type: "wait",
          config: { mode: "event", eventName: `e2e.never.${ctx.nonce}`, timeoutMs: 1000 },
          next: { event: "n-never-event", timeout: "n-timed-out" },
        },
        { id: "n-never-event", type: "script", config: { runtime: "bash", script: "echo never" } },
        {
          id: "n-timed-out",
          type: "script",
          config: { runtime: "bash", script: "echo timed-out" },
        },
        {
          id: "n-agent",
          type: "agent-task",
          config: {
            agentId: workerId,
            template: `Do the thing ${marker}`,
            tags: ["e2e-workflow"],
            priority: 70,
            outputSchema: { type: "object", properties: { handled: { type: "string" } } },
          },
          next: "n-after-agent",
        },
        {
          id: "n-after-agent",
          type: "script",
          inputs: { agent: "n-agent" },
          config: { runtime: "bash", script: "echo got-$0", args: ["{{agent.taskOutput.by}}"] },
        },
        {
          id: "n-foreach",
          type: "foreach",
          inputs: { items: "trigger.items" },
          config: {
            over: "{{items}}",
            itemKey: "id",
            concurrency: 2,
            body: {
              type: "agent-task",
              config: { agentId: workerId, template: `Item {{item.id}} #{{index}} ${marker}` },
            },
          },
          next: "n-after-foreach",
        },
        {
          id: "n-after-foreach",
          type: "notify",
          inputs: { fe: "n-foreach" },
          config: {
            channel: "swarm",
            template: "foreach ok={{fe.okCount}} failed={{fe.failedCount}}",
          },
        },
        {
          id: "n-sub",
          type: "sub-workflow",
          config: { workflowId: childId, inputs: { value: `from-parent-${marker}` } },
          next: { success: "n-after-sub" },
        },
        {
          id: "n-after-sub",
          type: "script",
          inputs: { sub: "n-sub" },
          config: { runtime: "bash", script: "echo sub-done-$0", args: ["{{sub.runId}}"] },
        },
        {
          id: "n-hitl",
          type: "human-in-the-loop",
          config: {
            title: `Approve ${marker}`,
            questions: approvalQuestions,
            approvers: { policy: "any" },
          },
          next: { approved: "n-hitl-ok", rejected: "n-hitl-no", timeout: "n-hitl-no" },
        },
        {
          id: "n-hitl-ok",
          type: "script",
          inputs: { decision: "n-hitl" },
          config: {
            runtime: "bash",
            script: "echo approved-$0",
            args: ["{{decision.responses.why}}"],
          },
        },
        { id: "n-hitl-no", type: "script", config: { runtime: "bash", script: "echo hitl-no" } },
      ],
    };
    const workflowId = await createWorkflow(ctx, "wf-async", definition, {}, workerId);

    const items = [{ id: "x1" }, { id: "x2" }, { id: "x3" }];
    const { runId } = await triggerWorkflow(
      ctx,
      workflowId,
      { kind: "async", items },
      { agentId: workerId },
    );

    // Everything async parks; the instant tail of each branch has not run yet.
    await waitForStep(ctx, runId, "n-wait-run", "waiting");
    await waitForStep(ctx, runId, "n-wait-global", "waiting");
    await waitForStep(ctx, runId, "n-hitl", "waiting");
    let detail = await getRunDetail(ctx, runId);
    expect(
      ["running", "waiting"].includes(String(detail.run.status)),
      `run is live while branches wait, got ${String(detail.run.status)}`,
    );

    // Signal routes: auth and input contract.
    expectStatus(
      await ctx.api("POST", `/api/workflow-runs/${runId}/events`, {
        apiKey: null,
        body: { name: "x" },
      }),
      [401],
      "run-scoped signal needs credentials",
    );
    expectStatus(
      await ctx.api("POST", "/api/workflow-events", { apiKey: null, body: { name: "x" } }),
      [401],
      "global signal needs credentials",
    );
    expectStatus(
      await ctx.api("POST", `/api/workflow-runs/${runId}/events`, { body: { payload: {} } }),
      [400],
      "run-scoped signal without a name",
    );
    expectStatus(
      await ctx.api("POST", "/api/workflow-events", { body: { payload: {} } }),
      [400],
      "global signal without a name",
    );
    expectStatus(
      await ctx.api("POST", "/api/workflow-runs/not-a-uuid/events", { body: { name: "x" } }),
      [400],
      "run-scoped signal with a malformed run id",
    );
    expectStatus(
      await ctx.api("POST", `/api/workflow-runs/${crypto.randomUUID()}/events`, {
        body: { name: "x" },
      }),
      [404],
      "run-scoped signal for an unknown run",
    );

    // Run-scoped wait: a global broadcast of the same name carries no run id, so it
    // does not wake the wait. The run-scoped signal does, only with a matching filter.
    const runEvent = `e2e.run.${ctx.nonce}`;
    const broadcast = await ctx.api("POST", "/api/workflow-events", {
      body: { name: runEvent, payload: { kind: "go" } },
    });
    expectStatus(broadcast, [200], "global broadcast of the run event name");
    expect(
      asRecord(broadcast.json).ok === true && asRecord(broadcast.json).name === runEvent,
      "global signal echoes the event",
    );
    const wrongFilter = await ctx.api("POST", `/api/workflow-runs/${runId}/events`, {
      body: { name: runEvent, payload: { kind: "stop" } },
    });
    expectStatus(wrongFilter, [200], "run-scoped signal with a payload the filter rejects");
    const signal = await ctx.api("POST", `/api/workflow-runs/${runId}/events`, {
      body: { name: runEvent, payload: { kind: "go", detail: marker } },
    });
    expectStatus(signal, [200], "run-scoped signal");
    expect(
      asRecord(signal.json).ok === true && asRecord(signal.json).runId === runId,
      "run-scoped signal echoes the run",
    );

    // Global wait with a function filter: the first payload fails the predicate.
    const globalEvent = `e2e.global.${ctx.nonce}`;
    for (const payload of [
      { release: "someone-else", n: 5 },
      { release: ctx.nonce, n: 1 },
      { release: ctx.nonce, n: 3, detail: marker },
    ]) {
      expectStatus(
        await ctx.api("POST", "/api/workflow-events", { body: { name: globalEvent, payload } }),
        [200],
        "global signal",
      );
    }

    // Approve the human-in-the-loop card as the operator.
    const request = await waitForApproval(ctx, runId);
    expect(request.workflowRunId === runId, "approval request belongs to the run");
    expect(request.status === "pending", "approval request is pending");
    expect(request.title === `Approve ${marker}`, "approval request keeps the node title");
    const questions = asRecords(request, "questions");
    expect(
      questions.length === 2 && questions[0]?.id === "go" && questions[1]?.required === false,
      "approval request keeps the node questions",
    );
    const approved = await respondApproval(ctx, String(request.id), {
      go: { approved: true },
      why: `because-${ctx.nonce}`,
    });
    const resolved = asRecord(approved.approvalRequest);
    expect(resolved.status === "approved", `approval resolved as ${String(resolved.status)}`);
    expect(resolved.resolvedBy === "operator", "the shared key answers as operator");

    detail = await waitForRun(ctx, runId, "completed", 90_000, "async fan-out run");

    // wait: time
    const waitTime = outputOf(detail, "n-wait-time");
    expect(waitTime.mode === "time" && typeof waitTime.firedAt === "string", "time wait output");
    expect(stepOf(detail, "n-wait-time").nextPort === "default", "time wait routes on default");
    expect(
      outputOf(detail, "n-after-time").stdout === "after-time",
      "time wait released its branch",
    );

    // wait: run-scoped event
    const waitRun = outputOf(detail, "n-wait-run");
    const runPayload = asRecord(waitRun.payload);
    expect(waitRun.mode === "event", "run wait output mode");
    expect(
      runPayload.kind === "go" && runPayload.detail === marker && runPayload._runId === runId,
      `run wait fired on the run-scoped signal, got ${JSON.stringify(runPayload)}`,
    );
    expect(stepOf(detail, "n-wait-run").nextPort === "event", "run wait routed on event");
    expect(outputOf(detail, "n-after-run").stdout === "after-run", "run wait released its branch");
    expect(!detail.steps.some((s) => s.nodeId === "n-run-timeout"), "run wait did not time out");

    // wait: global event with a function filter
    const waitGlobal = outputOf(detail, "n-wait-global");
    const globalPayload = asRecord(waitGlobal.payload);
    expect(
      globalPayload.n === 3 && globalPayload.detail === marker,
      `global wait fired on the third payload only, got ${JSON.stringify(globalPayload)}`,
    );
    expect(outputOf(detail, "n-after-global").stdout === "after-global", "global wait branch");

    // wait: timeout port
    expect(stepOf(detail, "n-wait-timeout").nextPort === "timeout", "wait timed out");
    expect(outputOf(detail, "n-timed-out").stdout === "timed-out", "timeout branch ran");
    expect(!detail.steps.some((s) => s.nodeId === "n-never-event"), "event branch did not run");

    // agent-task
    const agent = outputOf(detail, "n-agent");
    const agentOutput = asRecord(agent.taskOutput);
    expect(
      typeof agent.taskId === "string" && agentOutput.handled === `Do the thing ${marker}`,
      `agent-task output: ${JSON.stringify(agent)}`,
    );
    expect(
      outputOf(detail, "n-after-agent").stdout === `got-${agentOutput.by}`,
      "agent-task output reached the next node through inputs",
    );
    const agentTask = ctx.db.get<{
      source: string;
      agentId: string;
      status: string;
      priority: number;
      workflowRunStepId: string;
      tags: string;
    }>(
      "SELECT source, agentId, status, priority, workflowRunStepId, tags FROM agent_tasks WHERE id = ?",
      [String(agent.taskId)],
    );
    expect(
      agentTask?.source === "workflow" &&
        agentTask.agentId === workerId &&
        agentTask.status === "completed" &&
        agentTask.priority === 70 &&
        agentTask.workflowRunStepId === stepOf(detail, "n-agent").id &&
        String(agentTask.tags).includes("e2e-workflow"),
      `agent-task row: ${JSON.stringify(agentTask)}`,
    );

    // foreach over agent-tasks
    const foreach = outputOf(detail, "n-foreach");
    expect(foreach.okCount === 3 && foreach.failedCount === 0, "foreach counts");
    const results = asRecords(foreach, "results");
    expect(
      results.map((entry) => entry.itemKey).join(",") === "x1,x2,x3",
      "foreach results keep item order",
    );
    for (const [index, entry] of results.entries()) {
      const out = asRecord(asRecord(entry.output).taskOutput);
      expect(
        entry.status === "completed" && out.handled === `Item x${index + 1} #${index} ${marker}`,
        `foreach item ${index}: ${JSON.stringify(entry)}`,
      );
    }
    const note = outputOf(detail, "n-after-foreach");
    expect(note.message === "foreach ok=3 failed=0", "foreach aggregate reached the next node");
    const workflowTasks = ctx.db.query<{ id: string }>(
      "SELECT id FROM agent_tasks WHERE workflowRunId = ? AND source = 'workflow'",
      [runId],
    );
    expect(workflowTasks.length === 4, `expected 4 workflow tasks, got ${workflowTasks.length}`);

    // sub-workflow
    const sub = outputOf(detail, "n-sub");
    const childRunId = String(sub.runId);
    expect(stepOf(detail, "n-sub").nextPort === "success", "sub-workflow routes on success");
    expect(
      asRecord(asRecord(sub.outputs)["n-child"]).stdout === `child-from-parent-${marker}`,
      `sub-workflow outputs: ${JSON.stringify(sub.outputs)}`,
    );
    expect(!("trigger" in asRecord(sub.outputs)), "child trigger data is left out of the output");
    expect(
      outputOf(detail, "n-after-sub").stdout === `sub-done-${childRunId}`,
      "sub output reached",
    );
    const child = await getRunDetail(ctx, childRunId);
    expect(child.run.status === "completed", "child run completed");
    expect(
      child.parent?.stepId === stepOf(detail, "n-sub").id,
      `child run reports its parent step: ${JSON.stringify(child.parent)}`,
    );

    // run tree: the root and its one child, nothing left open
    const tree = await ctx.api("GET", `/api/workflow-runs/${runId}/tree`);
    expectStatus(tree, [200], "run tree");
    const treeJson = asRecord(tree.json);
    expect(treeJson.rootRunId === runId, "tree root");
    expect(treeJson.hasOpenWork === false, "finished tree has no open work");
    const treeRuns = asRecords(treeJson, "runs").map((run) => run.id);
    expect(
      treeRuns[0] === runId && treeRuns.includes(childRunId) && treeRuns.length === 2,
      `tree runs: ${JSON.stringify(treeRuns)}`,
    );
    expectStatus(
      await ctx.api("GET", `/api/workflow-runs/${crypto.randomUUID()}/tree`),
      [404],
      "tree of an unknown run",
    );

    // human-in-the-loop
    const hitl = outputOf(detail, "n-hitl");
    expect(hitl.status === "approved" && hitl.requestId === request.id, "hitl output");
    expect(
      asRecord(asRecord(hitl.responses).go).approved === true &&
        asRecord(hitl.responses).why === `because-${ctx.nonce}`,
      "hitl responses",
    );
    expect(stepOf(detail, "n-hitl").nextPort === "approved", "hitl routed on approved");
    expect(
      outputOf(detail, "n-hitl-ok").stdout === `approved-because-${ctx.nonce}`,
      "hitl answer reached the next node by question id",
    );
    expect((await approvalsForRun(ctx, runId, "approved")).length === 1, "one approved request");

    // Every async executor shows up in the step rows of this one run.
    const types = new Set(
      ctx.db
        .query<{ nodeType: string }>(
          "SELECT DISTINCT nodeType FROM workflow_run_steps WHERE runId = ?",
          [runId],
        )
        .map((row) => row.nodeType),
    );
    for (const type of [
      "wait",
      "agent-task",
      "foreach",
      "sub-workflow",
      "human-in-the-loop",
      "property-match",
    ]) {
      expect(types.has(type), `no workflow_run_steps row of type ${type}`);
    }

    await sim.stop();
  },
};
