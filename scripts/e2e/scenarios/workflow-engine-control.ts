// Workflow engine control plane: trigger contract (auth, schema, idempotency, cooldown,
// detach, webhook), failure policies, node retries and timeouts, run retry, run listing
// and the run tools. Slow runs start first so their waits overlap.
import { createHmac } from "node:crypto";
import { rm } from "node:fs/promises";
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  createWorkflow,
  getRunDetail,
  hasStep,
  outputOf,
  registerWorker,
  stepOf,
  triggerWorkflow,
  type WorkflowDef,
  type WorkflowNodeDef,
  waitForRun,
  waitForStep,
} from "./workflow-helpers";

function bash(id: string, script: string, next?: WorkflowNodeDef["next"], extra = {}) {
  return { id, type: "script", config: { runtime: "bash", script }, next, ...extra };
}

export const workflowEngineControl: Scenario = {
  name: "workflow-engine-control",
  order: 330,
  async run(ctx) {
    const marker = `ctl-${ctx.nonce}`;
    const workerId = await registerWorker(ctx, "wf-ctl");
    const flakyFile = `/tmp/e2e-wf-flaky-${ctx.nonce}`;
    const taskAttempts = new Map<string, number>();
    const sim = await ctx.startAgent({
      agentId: workerId,
      onTask: ({ taskId, task }) => {
        const text = String(task.task ?? "");
        if (text.includes("FAILME")) return { status: "failed", output: "boom from the task" };
        if (text.includes("FLAKY")) {
          const attempt = (taskAttempts.get(text) ?? 0) + 1;
          taskAttempts.set(text, attempt);
          return attempt === 1
            ? { status: "failed", output: "flaky first attempt" }
            : { status: "completed", output: `ok on attempt ${attempt}` };
        }
        return { status: "completed", output: `done ${taskId}` };
      },
    });
    const make = (name: string, definition: WorkflowDef, extra: Record<string, unknown> = {}) =>
      createWorkflow(ctx, name, definition, extra, workerId);
    const connection = await ctx.connectMcp(workerId);

    try {
      // ── start the slow runs first so their waits overlap ────────────────────
      const failId = await make("ctl-fail", {
        nodes: [
          bash("a", "echo ok", "b"),
          bash("b", "echo boom >&2; exit 3", "c"),
          bash("c", "echo after"),
        ],
      });
      const failRun = await triggerWorkflow(ctx, failId, {}, { agentId: workerId });

      const flakyId = await make("ctl-flaky", {
        nodes: [
          bash(
            "a",
            `f=${flakyFile}; if [ -f $f ]; then echo second; else touch $f; echo first >&2; exit 1; fi`,
            "z",
            { retry: { maxRetries: 2, strategy: "static", baseDelayMs: 1000 } },
          ),
          bash("z", "echo z"),
        ],
      });
      const flakyRun = await triggerWorkflow(ctx, flakyId, {}, { agentId: workerId });

      const exhaustId = await make("ctl-exhaust", {
        nodes: [
          bash("a", "echo nope >&2; exit 1", undefined, {
            retry: { maxRetries: 1, strategy: "static", baseDelayMs: 1000 },
          }),
        ],
      });
      const exhaustRun = await triggerWorkflow(ctx, exhaustId, {}, { agentId: workerId });

      const agentRetryId = await make("ctl-agent-retry", {
        nodes: [
          {
            id: "t",
            type: "agent-task",
            config: { agentId: workerId, template: `FLAKY task ${marker}` },
            retry: { maxRetries: 1, strategy: "static", baseDelayMs: 1000 },
          },
        ],
      });
      const agentRetryRun = await triggerWorkflow(ctx, agentRetryId, {}, { agentId: workerId });

      const continueId = await make("ctl-continue", {
        onNodeFailure: "continue",
        nodes: [
          bash("start", "echo go", ["t", "ok"]),
          {
            id: "t",
            type: "agent-task",
            config: { agentId: workerId, template: `FAILME continue ${marker}` },
            next: "after",
          },
          {
            id: "after",
            type: "script",
            inputs: { t: "t" },
            config: { runtime: "bash", script: "echo saw-$0", args: ["{{t.taskOutput}}"] },
          },
          bash("ok", "echo ok"),
        ],
      });
      const continueRun = await triggerWorkflow(ctx, continueId, {}, { agentId: workerId });

      const taskFailId = await make("ctl-task-fail", {
        nodes: [
          {
            id: "t",
            type: "agent-task",
            config: { agentId: workerId, template: `FAILME stop ${marker}` },
            next: "after",
          },
          bash("after", "echo never"),
        ],
      });
      const taskFailRun = await triggerWorkflow(ctx, taskFailId, {}, { agentId: workerId });

      const fanScript = 'if [ "$0" = bad ]; then echo bad-item >&2; exit 1; fi; echo ok-$0';
      const fanConfig = (policy: string, script: string) => ({
        over: "{{items}}",
        itemKey: "id",
        concurrency: 1,
        failurePolicy: policy,
        body: {
          type: "script",
          config: { runtime: "bash", script, args: ["{{item.id}}"] },
        },
      });
      const foreachNodes = (policy: string): WorkflowDef => ({
        nodes: [
          {
            id: "fan",
            type: "foreach",
            inputs: { items: "trigger.items" },
            config: fanConfig(policy, fanScript),
            next: "tail",
          },
          bash("tail", "echo tail"),
        ],
      });
      const items = [{ id: "good" }, { id: "bad" }, { id: "late" }];
      const collectId = await make("ctl-collect", foreachNodes("collect-outcomes"));
      const collectRun = await triggerWorkflow(ctx, collectId, { items }, { agentId: workerId });
      const failFastId = await make("ctl-failfast", foreachNodes("fail-fast"));
      const failFastRun = await triggerWorkflow(ctx, failFastId, { items }, { agentId: workerId });

      const childFailId = await make("ctl-child-fail", { nodes: [bash("boom", "exit 7")] });
      const subFailId = await make("ctl-sub-fail", {
        nodes: [
          {
            id: "sub",
            type: "sub-workflow",
            config: { workflowId: childFailId, inputs: {} },
            next: "after",
          },
          bash("after", "echo never"),
        ],
      });
      const subFailRun = await triggerWorkflow(ctx, subFailId, {}, { agentId: workerId });

      // ── synchronous failure shapes ──────────────────────────────────────────
      const mustPassId = await make("ctl-mustpass", {
        nodes: [
          bash("a", `echo '{"x":1}'`, "z", {
            validation: {
              executor: "validate",
              config: { targetNodeId: "a", schema: { type: "object", required: ["y"] } },
              mustPass: true,
            },
          }),
          bash("z", "echo z"),
        ],
      });
      const mustPass = await waitForRun(
        ctx,
        (await triggerWorkflow(ctx, mustPassId, {}, { agentId: workerId })).runId,
        "failed",
        20_000,
        "mustPass run",
      );
      expect(
        String(stepOf(mustPass, "a").error).includes("Validation failed (mustPass)") &&
          !hasStep(mustPass, "z"),
        "a failed mustPass validation stops the branch",
      );
      expect(String(mustPass.run.error).includes("Failed nodes: a"), "run error names the node");

      const timeoutId = await make("ctl-timeout", {
        nodes: [
          {
            id: "slow",
            type: "script",
            config: { runtime: "bash", script: "sleep 5", timeout: 1000 },
          },
        ],
      });
      const timedOut = await waitForRun(
        ctx,
        (await triggerWorkflow(ctx, timeoutId, {}, { agentId: workerId })).runId,
        "failed",
        20_000,
        "script timeout run",
      );
      expect(
        String(stepOf(timedOut, "slow").error).includes("timed out after 1000ms"),
        `script timeout: ${String(stepOf(timedOut, "slow").error)}`,
      );

      const outSchemaId = await make("ctl-out-schema", {
        nodes: [
          bash("a", `echo '{"answer":5}'`, undefined, {
            outputSchema: {
              type: "object",
              required: ["answer"],
              properties: { answer: { type: "string" } },
            },
          }),
        ],
      });
      const outFailed = await waitForRun(
        ctx,
        (await triggerWorkflow(ctx, outSchemaId, {}, { agentId: workerId })).runId,
        "failed",
        20_000,
        "output schema run",
      );
      expect(
        String(stepOf(outFailed, "a").error).includes("Output schema validation failed"),
        "node outputSchema mismatch fails the step",
      );
      const inSchemaId = await make("ctl-in-schema", {
        nodes: [
          bash("a", "echo hi", undefined, {
            inputSchema: {
              type: "object",
              required: ["trigger"],
              properties: { trigger: { type: "object", required: ["mustHave"] } },
            },
          }),
        ],
      });
      const inFailed = await waitForRun(
        ctx,
        (await triggerWorkflow(ctx, inSchemaId, {}, { agentId: workerId })).runId,
        "failed",
        20_000,
        "input schema run",
      );
      expect(
        String(stepOf(inFailed, "a").error).includes("Input schema validation failed"),
        "node inputSchema mismatch fails the step",
      );

      const diagId = await make("ctl-diag", {
        nodes: [
          {
            id: "say",
            type: "notify",
            config: { channel: "email", template: `hello {{nobody.here}} ${marker}` },
          },
        ],
      });
      const diag = await waitForRun(
        ctx,
        (await triggerWorkflow(ctx, diagId, {}, { agentId: workerId })).runId,
        "completed",
        20_000,
        "diagnostics run",
      );
      const diagnostics = JSON.stringify(stepOf(diag, "say").diagnostics);
      expect(
        diagnostics.includes("unresolvedTokens") && diagnostics.includes("nobody.here"),
        `unresolved tokens are reported on the step: ${diagnostics}`,
      );

      // ── trigger contract ────────────────────────────────────────────────────
      expectStatus(
        await ctx.api("POST", `/api/workflows/${crypto.randomUUID()}/trigger`, { body: {} }),
        [404],
        "trigger an unknown workflow",
      );
      expectStatus(
        await ctx.api("POST", `/api/workflows/${failId}/trigger`, { apiKey: null, body: {} }),
        [401],
        "trigger without credentials",
      );

      const schemaId = await make(
        "ctl-schema",
        { nodes: [bash("a", "echo ok")] },
        {
          triggerSchema: {
            type: "object",
            required: ["pr"],
            properties: {
              pr: {
                type: "object",
                required: ["number"],
                properties: { number: { type: "number" } },
              },
            },
          },
        },
      );
      const runsBefore = asRecord(
        asRecord((await ctx.api("GET", `/api/workflows/${schemaId}/runs`)).json).page,
      );
      const rejected = await ctx.api("POST", `/api/workflows/${schemaId}/trigger`, {
        body: { pr: { number: "five" } },
      });
      expectStatus(rejected, [400], "trigger with a payload that breaks the schema");
      const rejectedBody = asRecord(rejected.json);
      expect(
        rejectedBody.error === "TriggerSchemaError" &&
          Array.isArray(rejectedBody.details) &&
          String(rejectedBody.details[0]).includes("pr.number"),
        `schema failure body: ${rejected.text}`,
      );
      const runsAfter = asRecord(
        asRecord((await ctx.api("GET", `/api/workflows/${schemaId}/runs`)).json).page,
      );
      expect(runsBefore.total === runsAfter.total, "a rejected payload creates no run");
      const goodSchemaRun = await triggerWorkflow(
        ctx,
        schemaId,
        { pr: { number: 5 } },
        { agentId: workerId },
      );
      await waitForRun(ctx, goodSchemaRun.runId, "completed", 20_000, "schema run");

      // Idempotency-Key: create and trigger.
      const idemKey = `idem-${ctx.nonce}`;
      const createBody = {
        name: `ctl-idem-${ctx.nonce}`,
        definition: { nodes: [bash("a", "echo idem")] },
      };
      const firstCreate = await ctx.api("POST", "/api/workflows", {
        headers: { "Idempotency-Key": idemKey },
        body: createBody,
      });
      expectStatus(firstCreate, [201], "keyed create");
      const idemId = asString(asRecord(firstCreate.json).id, "keyed workflow id");
      const replayCreate = await ctx.api("POST", "/api/workflows", {
        headers: { "Idempotency-Key": idemKey },
        body: createBody,
      });
      expectStatus(replayCreate, [201], "replayed create");
      expect(
        asRecord(replayCreate.json).id === idemId,
        "a replayed create returns the same workflow",
      );
      expect(replayCreate.headers.get("idempotent-replayed") === "true", "create replay header");
      expect(
        firstCreate.headers.get("idempotent-replayed") === null,
        "first create is not a replay",
      );
      expectStatus(
        await ctx.api("POST", "/api/workflows", {
          headers: { "Idempotency-Key": idemKey },
          body: { ...createBody, description: "different" },
        }),
        [409],
        "same key, different create body",
      );
      const idemCount = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM workflows WHERE name = ?",
        [createBody.name],
      );
      expect(idemCount?.n === 1, "one workflow exists for the keyed create");

      const runKey = `run-${ctx.nonce}`;
      const keyed = await ctx.api("POST", `/api/workflows/${idemId}/trigger`, {
        headers: { "Idempotency-Key": runKey },
        body: { a: 1 },
      });
      expectStatus(keyed, [201], "keyed trigger");
      const keyedRunId = asString(asRecord(keyed.json).runId, "keyed run id");
      const replayed = await ctx.api("POST", `/api/workflows/${idemId}/trigger`, {
        headers: { "Idempotency-Key": runKey },
        body: { a: 1 },
      });
      expectStatus(replayed, [201], "replayed trigger");
      expect(
        asRecord(replayed.json).runId === keyedRunId &&
          replayed.headers.get("idempotent-replayed") === "true",
        "a replayed trigger returns the first run",
      );
      expectStatus(
        await ctx.api("POST", `/api/workflows/${idemId}/trigger`, {
          headers: { "Idempotency-Key": runKey },
          body: { a: 2 },
        }),
        [409],
        "same key, different trigger body",
      );
      const badKey = await ctx.api("POST", `/api/workflows/${idemId}/trigger`, {
        headers: { "Idempotency-Key": "bad key with spaces" },
        body: {},
      });
      expectStatus(badKey, [400], "malformed key");
      expect(
        String(asRecord(badKey.json).error).includes("Idempotency-Key"),
        "malformed key error",
      );
      const keyedRuns = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM workflow_runs WHERE workflowId = ?",
        [idemId],
      );
      expect(keyedRuns?.n === 1, "the keyed trigger started exactly one run");
      await waitForRun(ctx, keyedRunId, "completed", 20_000, "keyed run");
      expectStatus(
        await ctx.api("DELETE", `/api/workflows/${idemId}`),
        [204],
        "delete keyed workflow",
      );
      expectStatus(
        await ctx.api("POST", `/api/workflows/${idemId}/trigger`, {
          headers: { "Idempotency-Key": runKey },
          body: { a: 1 },
        }),
        [410],
        "replay after the workflow was deleted",
      );

      // Cooldown: the second trigger inside the window is recorded as skipped.
      const cooldownId = await make(
        "ctl-cooldown",
        { nodes: [bash("a", "echo c")] },
        { cooldown: { seconds: 120 } },
      );
      const first = await triggerWorkflow(ctx, cooldownId, {}, { agentId: workerId });
      const second = await triggerWorkflow(ctx, cooldownId, {}, { agentId: workerId });
      expect(!first.skipped && second.skipped, "the second trigger inside the cooldown is skipped");
      const skippedRun = await getRunDetail(ctx, second.runId);
      expect(
        skippedRun.run.status === "skipped" && skippedRun.steps.length === 0,
        "a skipped run has no steps",
      );

      // wait=false answers as soon as the run is committed.
      const detachId = await make("ctl-detach", {
        nodes: [{ id: "w", type: "wait", config: { mode: "time", durationMs: 600000 } }],
      });
      const detached = await triggerWorkflow(ctx, detachId, {}, { agentId: workerId, wait: false });
      await waitForStep(ctx, detached.runId, "w", "waiting");
      await ctx.api("POST", `/api/workflow-runs/${detached.runId}/cancel`, {
        body: { reason: "cleanup" },
      });

      // Webhook: opt-in per workflow, HMAC over the raw body.
      const secret = `whsec-${ctx.nonce}`;
      const hookId = await make(
        "ctl-hook",
        { nodes: [bash("a", "echo hook")] },
        { triggers: [{ type: "webhook", hmacSecret: secret }] },
      );
      const hookBody = JSON.stringify({ event: "ping", marker });
      const signature = `sha256=${createHmac("sha256", secret).update(hookBody).digest("hex")}`;
      expectStatus(
        await ctx.api("POST", `/api/webhooks/${hookId}`, { apiKey: null, rawBody: hookBody }),
        [401],
        "webhook without a signature",
      );
      expectStatus(
        await ctx.api("POST", `/api/webhooks/${hookId}`, {
          apiKey: null,
          rawBody: hookBody,
          headers: { "X-Hub-Signature-256": "sha256=deadbeef" },
        }),
        [401],
        "webhook with a bad signature",
      );
      const hook = await ctx.api("POST", `/api/webhooks/${hookId}`, {
        apiKey: null,
        rawBody: hookBody,
        headers: { "X-Hub-Signature-256": signature, "Content-Type": "application/json" },
      });
      expectStatus(hook, [201], "signed webhook");
      const hookRun = await waitForRun(
        ctx,
        asString(asRecord(hook.json).runId, "webhook run id"),
        "completed",
        20_000,
        "webhook run",
      );
      expect(
        asRecord(hookRun.run.triggerData).marker === marker,
        "the webhook body became the trigger data",
      );
      expectStatus(
        await ctx.api("POST", `/api/webhooks/${failId}`, { apiKey: null, rawBody: "{}" }),
        [400, 404],
        "a workflow without a webhook trigger is not reachable by webhook",
      );
      expectStatus(
        await ctx.api("POST", `/api/webhooks/${crypto.randomUUID()}`, {
          apiKey: null,
          rawBody: "{}",
        }),
        [404],
        "webhook for an unknown workflow",
      );

      // ── MCP trigger tool ────────────────────────────────────────────────────
      const toolKey = `tool-${ctx.nonce}`;
      const viaTool = await callToolOk(connection, "trigger-workflow", {
        id: schemaId,
        triggerData: { pr: { number: 7 } },
        idempotencyKey: toolKey,
      });
      const toolRunId = asString(viaTool.structured.runId, "tool run id");
      expect(
        viaTool.structured.skipped === false && viaTool.text.includes(toolRunId),
        "trigger tool",
      );
      const toolReplay = await callToolOk(connection, "trigger-workflow", {
        id: schemaId,
        triggerData: { pr: { number: 7 } },
        idempotencyKey: toolKey,
      });
      expect(
        toolReplay.structured.replayed === true && toolReplay.structured.runId === toolRunId,
        "a replayed tool trigger returns the first run",
      );
      const toolConflict = await callToolErr(connection, "trigger-workflow", {
        id: schemaId,
        triggerData: { pr: { number: 8 } },
        idempotencyKey: toolKey,
      });
      expect(toolConflict.structured.idempotencyConflict === true, "tool key conflict");
      const toolSchema = await callToolErr(connection, "trigger-workflow", {
        id: schemaId,
        triggerData: { pr: {} },
      });
      expect(
        Array.isArray(toolSchema.structured.validationErrors) &&
          asRecord(toolSchema.structured.triggerSchema).required !== undefined,
        "tool schema failure carries validationErrors and the schema",
      );
      await callToolErr(connection, "trigger-workflow", { id: crypto.randomUUID() }, "not found");
      const toolDetached = await callToolOk(connection, "trigger-workflow", {
        id: cooldownId,
        wait: false,
      });
      expect(
        toolDetached.structured.skipped === true,
        "tool trigger inside the cooldown is skipped",
      );
      await waitForRun(ctx, toolRunId, "completed", 20_000, "tool run");

      // ── runs list and run reads ─────────────────────────────────────────────
      const listId = await make("ctl-list", { nodes: [bash("a", "echo l")] });
      for (let index = 0; index < 5; index++) {
        await waitForRun(
          ctx,
          (await triggerWorkflow(ctx, listId, { index }, { agentId: workerId })).runId,
          "completed",
          20_000,
          "list run",
        );
      }
      const page1 = await ctx.api("GET", `/api/workflows/${listId}/runs?limit=2`);
      expectStatus(page1, [200], "first runs page");
      const page1Json = asRecord(page1.json);
      const page1Info = asRecord(page1Json.page);
      expect(
        asRecords(page1Json, "runs").length === 2 &&
          page1Info.total === 5 &&
          page1Info.hasMore === true &&
          page1Info.nextOffset === 2 &&
          page1Info.limit === 2 &&
          page1Info.offset === 0,
        `runs page 1: ${JSON.stringify(page1Info)}`,
      );
      expect(!("context" in asRecords(page1Json, "runs")[0]!), "run list rows carry no context");
      const page3 = asRecord(
        (await ctx.api("GET", `/api/workflows/${listId}/runs?limit=2&offset=4`)).json,
      );
      expect(
        asRecords(page3, "runs").length === 1 &&
          asRecord(page3.page).hasMore === false &&
          asRecord(page3.page).nextOffset === undefined,
        "last runs page",
      );
      const byStatus = asRecord(
        (await ctx.api("GET", `/api/workflows/${listId}/runs?status=failed`)).json,
      );
      expect(asRecords(byStatus, "runs").length === 0, "status filter excludes completed runs");
      expectStatus(
        await ctx.api("GET", `/api/workflows/${listId}/runs?limit=0`),
        [400],
        "runs limit must be positive",
      );
      expectStatus(
        await ctx.api("GET", `/api/workflows/${listId}/runs?status=bogus`),
        [400],
        "runs status must be a run status",
      );
      const slimRun = await ctx.api("GET", `/api/workflow-runs/${goodSchemaRun.runId}?fields=slim`);
      expectStatus(slimRun, [200], "slim run read");
      expect(
        !("context" in asRecord(asRecord(slimRun.json).run)) &&
          asRecords(slimRun.json, "steps").every((step) => !("input" in step)),
        "fields=slim drops the context and step inputs",
      );
      expectStatus(
        await ctx.api("GET", `/api/workflow-runs/${crypto.randomUUID()}`),
        [404],
        "read an unknown run",
      );

      const toolPage = await callToolOk(connection, "list-workflow-runs", {
        workflowId: listId,
        limit: 2,
        offset: 1,
      });
      const toolRuns = asRecords(toolPage.structured, "runs");
      expect(
        toolRuns.length === 2 &&
          asRecord(toolPage.structured.page).total === 5 &&
          toolRuns.every((run) => "triggerDataSummary" in run && !("context" in run)),
        "list-workflow-runs is slim and paginated",
      );
      const toolFull = await callToolOk(connection, "list-workflow-runs", {
        workflowId: listId,
        includeContext: true,
        status: "completed",
        limit: 1,
      });
      expect(
        "context" in asRecords(toolFull.structured, "runs")[0]!,
        "includeContext returns context",
      );
      const toolRead = await callToolOk(connection, "get-workflow-run", {
        id: goodSchemaRun.runId,
      });
      expect(
        asRecord(toolRead.structured.run).status === "completed" &&
          asRecords(toolRead.structured, "steps").length === 1 &&
          toolRead.text.includes("a: completed"),
        "get-workflow-run returns the run and renders its steps",
      );
      const toolSlim = await callToolOk(connection, "get-workflow-run", {
        id: goodSchemaRun.runId,
        fields: "slim",
      });
      expect(!("context" in asRecord(toolSlim.structured.run)), "get-workflow-run slim");
      await callToolErr(connection, "get-workflow-run", { id: crypto.randomUUID() }, "not found");

      // ── gather the slow runs ────────────────────────────────────────────────
      const failed = await waitForRun(ctx, failRun.runId, "failed", 20_000, "failing run");
      expect(
        String(failed.run.error) === "Step failed: boom",
        `failing run error: ${failed.run.error}`,
      );
      expect(stepOf(failed, "b").status === "failed" && !hasStep(failed, "c"), "c never ran");
      const failedOutput = asRecord(stepOf(failed, "b").output);
      expect(
        failedOutput.exitCode === 3 && failedOutput.stderr === "boom",
        "a failed script keeps its exit code and stderr as step output",
      );
      expect(stepOf(failed, "a").status === "completed", "the step before the failure completed");

      const flaky = await waitForRun(ctx, flakyRun.runId, "completed", 60_000, "flaky retry run");
      expect(
        stepOf(flaky, "a").retryCount === 1 && outputOf(flaky, "a").stdout === "second",
        "a retried step completes on its second attempt",
      );
      expect(outputOf(flaky, "z").stdout === "z", "the retried step released its successor");

      const exhausted = await waitForRun(
        ctx,
        exhaustRun.runId,
        "failed",
        60_000,
        "exhausted retries",
      );
      expect(
        stepOf(exhausted, "a").retryCount === 1 && String(exhausted.run.error).includes("nope"),
        `retries exhausted: ${JSON.stringify([stepOf(exhausted, "a").retryCount, exhausted.run.error])}`,
      );

      const agentRetry = await waitForRun(
        ctx,
        agentRetryRun.runId,
        "completed",
        60_000,
        "agent-task retry",
      );
      const retryTasks = ctx.db.query<{ status: string }>(
        "SELECT status FROM agent_tasks WHERE workflowRunId = ? ORDER BY createdAt",
        [agentRetryRun.runId],
      );
      expect(
        retryTasks.map((task) => task.status).join(",") === "failed,completed" &&
          String(outputOf(agentRetry, "t").taskOutput).includes("ok on attempt 2"),
        `a failed agent-task is retried with a fresh task: ${JSON.stringify(retryTasks)}`,
      );

      const continued = await waitForRun(
        ctx,
        continueRun.runId,
        "completed",
        30_000,
        "continue policy",
      );
      const continuedOut = outputOf(continued, "t");
      expect(
        String(continuedOut.taskOutput).startsWith("[FAILED:") &&
          String(continuedOut.taskOutput).endsWith("This node failed or was cancelled."),
        `onNodeFailure=continue records the failure as output: ${JSON.stringify(continuedOut)}`,
      );
      expect(
        String(outputOf(continued, "after").stdout).startsWith("saw-[FAILED:"),
        "the successor of a continued failure still runs",
      );
      const stopped = await waitForRun(
        ctx,
        taskFailRun.runId,
        "failed",
        30_000,
        "task failure, default policy",
      );
      expect(
        String(stopped.run.error).length > 0 &&
          stepOf(stopped, "t").status !== "completed" &&
          !hasStep(stopped, "after"),
        `default policy fails the run on a failed task: ${String(stopped.run.error)}`,
      );

      const collected = await waitForRun(
        ctx,
        collectRun.runId,
        "completed",
        30_000,
        "collect-outcomes",
      );
      const fan = outputOf(collected, "fan");
      expect(
        fan.okCount === 2 && fan.failedCount === 1,
        `collect-outcomes counts: ${JSON.stringify(fan)}`,
      );
      expect(
        asRecords(fan, "results")
          .map((entry) => `${entry.itemKey}:${entry.status}`)
          .join(",") === "good:completed,bad:failed,late:completed",
        "every item reaches an outcome",
      );
      expect(outputOf(collected, "tail").stdout === "tail", "collect-outcomes routes on");
      const failFast = await waitForRun(ctx, failFastRun.runId, "failed", 30_000, "fail-fast");
      expect(!hasStep(failFast, "tail"), "fail-fast does not route to the successor");
      const lateChild = failFast.steps.find((step) => step.nodeId === "fan#late");
      expect(
        lateChild?.status === "cancelled" &&
          String(lateChild.error).includes("not started: fail-fast after item bad failed"),
        `fail-fast cancels the queued item: ${JSON.stringify(lateChild)}`,
      );

      // Retry a failed fan-out: the finished item stays, the failed and cancelled ones rerun.
      const goodBefore = failFast.steps.find((step) => step.nodeId === "fan#good");
      expect(goodBefore?.status === "completed", "the first item finished before the failure");
      const fixFan = await ctx.api("PATCH", `/api/workflows/${failFastId}/nodes/fan`, {
        body: { config: fanConfig("fail-fast", "echo healed-$0") },
      });
      expectStatus(fixFan, [200], "fix the fan-out body");
      expectStatus(
        await ctx.api("POST", `/api/workflow-runs/${failFastRun.runId}/retry`),
        [200],
        "retry the failed fan-out",
      );
      const fanHealed = await waitForRun(
        ctx,
        failFastRun.runId,
        "completed",
        30_000,
        "retried fan-out",
      );
      const fanRows = fanHealed.steps.filter((step) => String(step.nodeId).startsWith("fan#"));
      const rowsOf = (key: string) => fanRows.filter((step) => step.nodeId === `fan#${key}`);
      expect(
        rowsOf("good").length === 1 && rowsOf("good")[0]?.id === goodBefore?.id,
        "the completed item was not run again",
      );
      for (const key of ["bad", "late"]) {
        const rows = rowsOf(key);
        expect(
          rows.length === 2 && rows.some((step) => step.status === "completed"),
          `item ${key} got a second attempt row: ${JSON.stringify(rows.map((r) => r.status))}`,
        );
      }
      const healedAggregate = outputOf(fanHealed, "fan");
      expect(
        healedAggregate.okCount === 3 &&
          asRecord(asRecords(healedAggregate, "results")[1]?.output).stdout === "healed-bad",
        `the retried fan-out aggregates all three items: ${JSON.stringify(healedAggregate)}`,
      );
      expect(outputOf(fanHealed, "tail").stdout === "tail", "the retried fan-out routes on");

      const subFailed = await waitForRun(ctx, subFailRun.runId, "failed", 30_000, "failing child");
      expect(
        String(subFailed.run.error).includes("Child workflow run") && !hasStep(subFailed, "after"),
        `a failing child fails the parent: ${String(subFailed.run.error)}`,
      );

      // ── run retry: fix the node, retry, only the failed step runs again ─────
      const aStepId = stepOf(failed, "a").id;
      const fix = await ctx.api("PATCH", `/api/workflows/${failId}/nodes/b`, {
        body: { config: { runtime: "bash", script: "echo fixed" } },
      });
      expectStatus(fix, [200], "fix the failing node");
      const retried = await ctx.api("POST", `/api/workflow-runs/${failRun.runId}/retry`);
      expectStatus(retried, [200], "retry the failed run");
      expect(asRecord(retried.json).success === true, "retry answers success");
      const recovered = await waitForRun(ctx, failRun.runId, "completed", 30_000, "retried run");
      expect(stepOf(recovered, "a").id === aStepId, "the completed step was not run again");
      expect(
        recovered.steps.some(
          (step) =>
            step.nodeId === "b" &&
            step.status === "completed" &&
            asRecord(step.output).stdout === "fixed",
        ) && outputOf(recovered, "c").stdout === "after",
        "the failed step ran again with the fixed config and released its successor",
      );
      const refusal = await ctx.api("POST", `/api/workflow-runs/${failRun.runId}/retry`);
      expectStatus(refusal, [400], "retry a completed run");
      expect(
        String(asRecord(refusal.json).error).includes("not in failed state"),
        "retry a completed run explains itself",
      );
      const retryUnknown = await ctx.api("POST", `/api/workflow-runs/${crypto.randomUUID()}/retry`);
      expectStatus(retryUnknown, [404], "retry an unknown run");
      expect(
        String(asRecord(retryUnknown.json).error).includes("not found"),
        "retry an unknown run says it is not found",
      );
      const cancelDone = await ctx.api("POST", `/api/workflow-runs/${failRun.runId}/cancel`, {
        body: {},
      });
      expectStatus(cancelDone, [400], "cancel a completed run");
      expect(
        String(asRecord(cancelDone.json).error).includes("'completed'"),
        "cancel names the state",
      );
      const cancelUnknown = await ctx.api(
        "POST",
        `/api/workflow-runs/${crypto.randomUUID()}/cancel`,
        { body: {} },
      );
      expectStatus(cancelUnknown, [400], "cancel an unknown run");
      expect(
        String(asRecord(cancelUnknown.json).error).includes("not found"),
        "cancel unknown run",
      );

      // retry-workflow-run tool: fix and retry the exhausted run.
      await callToolErr(
        connection,
        "retry-workflow-run",
        { runId: failRun.runId },
        "not in failed state",
      );
      await callToolErr(
        connection,
        "retry-workflow-run",
        { runId: crypto.randomUUID() },
        "not found",
      );
      const fixExhaust = await ctx.api("PATCH", `/api/workflows/${exhaustId}/nodes/a`, {
        body: { config: { runtime: "bash", script: "echo healed" }, retry: { maxRetries: 0 } },
      });
      expectStatus(fixExhaust, [200], "fix the exhausted node");
      const toolRetry = await callToolOk(connection, "retry-workflow-run", {
        runId: exhaustRun.runId,
      });
      expect(toolRetry.text.includes(exhaustRun.runId), "retry tool names the run");
      const healed = await waitForRun(
        ctx,
        exhaustRun.runId,
        "completed",
        30_000,
        "tool-retried run",
      );
      expect(
        healed.steps.some(
          (step) => step.nodeId === "a" && asRecord(step.output).stdout === "healed",
        ),
        "the tool retry ran the fixed node",
      );

      // Workflow list filters that read run history.
      const failedWorkflows = await ctx.api("GET", "/api/workflows?lastRunStatus=failed&limit=500");
      expectStatus(failedWorkflows, [200], "list by lastRunStatus");
      const failedIds = (failedWorkflows.json as Record<string, unknown>[]).map((row) => row.id);
      expect(
        failedIds.includes(timeoutId),
        "lastRunStatus=failed lists a workflow whose last run failed",
      );
      expect(
        !failedIds.includes(failId),
        "a retried-and-completed workflow is not listed as failed",
      );
      const erroring = await ctx.api("GET", "/api/workflows?consecutiveErrorsMin=1&limit=500");
      expectStatus(erroring, [200], "list by consecutiveErrorsMin");
      expect(
        (erroring.json as Record<string, unknown>[]).some((row) => row.id === timeoutId),
        "consecutiveErrorsMin lists a workflow whose latest runs failed",
      );
      const toolFailed = await callToolOk(connection, "list-workflows", {
        lastRunStatus: "failed",
        consecutiveErrorsMin: 1,
      });
      expect(
        asRecords(toolFailed.structured, "workflows").some((row) => row.id === timeoutId),
        "list-workflows filters on run history",
      );
    } finally {
      await sim.stop();
      await connection.close();
      await rm(flakyFile, { force: true });
    }
  },
};
