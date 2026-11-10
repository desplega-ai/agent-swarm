// A signed webhook delivery is filtered after the signature check and before a
// run is saved. A match walks the workflow; a miss answers 200 and leaves no
// run or step rows. The legacy events allowlist and the standard-webhooks
// preset stay on that same path.
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { hmacSignature } from "./platform-helpers";
import { createWorkflow, type WorkflowDef, waitForRun } from "./workflow-helpers";

const definition: WorkflowDef = {
  nodes: [{ id: "note", type: "script", config: { runtime: "bash", script: "echo filtered" } }],
};

function countRows(ctx: ScenarioContext, sql: string, workflowId: string): number {
  return Number(ctx.db.get<{ n: number }>(sql, [workflowId])?.n ?? 0);
}

function runCount(ctx: ScenarioContext, workflowId: string): number {
  return countRows(ctx, "SELECT COUNT(*) AS n FROM workflow_runs WHERE workflowId = ?", workflowId);
}

function stepCount(ctx: ScenarioContext, workflowId: string): number {
  return countRows(
    ctx,
    `SELECT COUNT(*) AS n FROM workflow_run_steps
     WHERE runId IN (SELECT id FROM workflow_runs WHERE workflowId = ?)`,
    workflowId,
  );
}

export const workflowWebhookFilter: Scenario = {
  name: "workflow-webhook-filter",
  order: 322,
  async run(ctx) {
    const secret = `whsec-${ctx.nonce}`;
    const sign = (body: string) => hmacSignature(secret, body);
    const deliver = (id: string, body: string, headers: Record<string, string> = {}) =>
      ctx.api("POST", `/api/webhooks/${id}`, {
        apiKey: null,
        rawBody: body,
        headers: { "Content-Type": "application/json", ...headers },
      });

    const empty = await ctx.api("POST", "/api/workflows", {
      body: {
        name: `hook-filter-empty-${ctx.nonce}`,
        definition,
        triggers: [{ type: "webhook", hmacSecret: secret, filter: {} }],
      },
    });
    expectStatus(empty, [400], "create rejects an empty webhook filter");
    expect(
      String(asRecord(empty.json).error).includes("filter"),
      `empty filter error names the field: ${empty.text}`,
    );

    const id = await createWorkflow(ctx, "hook-filter", definition, {
      triggers: [
        {
          type: "webhook",
          hmacSecret: secret,
          events: ["pull_request"],
          filter: {
            body: { action: ["opened", "reopened", "ready_for_review", "synchronize"] },
          },
        },
      ],
    });

    const closed = JSON.stringify({ action: "closed", token: `secret-${ctx.nonce}` });
    const badSignature = await deliver(id, closed, {
      "X-Hub-Signature-256": "sha256=deadbeef",
      "X-GitHub-Event": "push",
    });
    expectStatus(badSignature, [401], "a bad signature is rejected before the filter");
    expect(
      asRecord(badSignature.json).error === "Invalid signature",
      `bad signature message: ${badSignature.text}`,
    );
    expect(
      runCount(ctx, id) === 0 && stepCount(ctx, id) === 0,
      "a rejected signature writes no run or step",
    );

    const opened = JSON.stringify({ action: "opened", nonce: ctx.nonce });
    const wrongEvent = await deliver(id, opened, {
      "X-Hub-Signature-256": sign(opened),
      "X-GitHub-Event": "push",
    });
    expectStatus(wrongEvent, [200], "the events allowlist skips before a run is saved");
    expect(
      asRecord(wrongEvent.json).skipped === true &&
        asRecord(wrongEvent.json).reason === "event-not-allowed" &&
        asRecord(wrongEvent.json).event === "push",
      `events skip shape: ${wrongEvent.text}`,
    );
    expect(
      runCount(ctx, id) === 0 && stepCount(ctx, id) === 0,
      "an events skip writes no run or step",
    );

    const filtered = await deliver(id, closed, {
      "X-Hub-Signature-256": sign(closed),
      "X-GitHub-Event": "pull_request",
    });
    expectStatus(filtered, [200], "a body filter skips before a run is saved");
    const skipped = asRecord(filtered.json);
    const match = asRecord(skipped.match);
    expect(
      skipped.skipped === true &&
        skipped.reason === "filter-not-matched" &&
        match.source === "body" &&
        match.path === "action" &&
        !filtered.text.includes(`secret-${ctx.nonce}`),
      `filter skip does not echo the body: ${filtered.text}`,
    );
    expect(
      runCount(ctx, id) === 0 && stepCount(ctx, id) === 0,
      "a filter skip writes no run or step",
    );

    const matched = await deliver(id, opened, {
      "X-Hub-Signature-256": sign(opened),
      "x-github-event": "pull_request",
    });
    expectStatus(matched, [201], "a matching signed delivery starts a run");
    const runId = String(asRecord(matched.json).runId);
    const detail = await waitForRun(ctx, runId, "completed", 20_000, "filtered webhook run");
    expect(
      asRecord(detail.run.triggerData).action === "opened" &&
        asRecord(detail.run.triggerData).nonce === ctx.nonce,
      "the parsed webhook body is the run trigger data",
    );
    expect(
      detail.steps.some((step) => step.nodeId === "note" && step.status === "completed"),
      `the script step ran: ${JSON.stringify(detail.steps)}`,
    );
    expect(runCount(ctx, id) === 1, "the matching delivery is the only persisted run");

    const presetId = await createWorkflow(ctx, "hook-filter-preset", definition, {
      triggers: [
        {
          type: "webhook",
          hmacSecret: secret,
          preset: "standard-webhooks",
          events: ["contact.created"],
        },
      ],
    });
    const otherType = JSON.stringify({ type: "user.deleted", data: { id: "1" } });
    const presetBad = await deliver(presetId, otherType, {
      "X-Hub-Signature-256": "sha256=deadbeef",
    });
    expectStatus(presetBad, [401], "a preset webhook still rejects a bad signature");
    expect(runCount(ctx, presetId) === 0, "a preset bad signature writes no run");

    const presetSkip = await deliver(presetId, otherType, {
      "X-Hub-Signature-256": sign(otherType),
    });
    expectStatus(presetSkip, [200], "standard-webhooks preset skips another event type");
    expect(
      asRecord(presetSkip.json).skipped === true &&
        asRecord(presetSkip.json).reason === "event-not-allowed" &&
        asRecord(presetSkip.json).event === "user.deleted",
      `preset skip shape: ${presetSkip.text}`,
    );
    expect(runCount(ctx, presetId) === 0, "a preset skip writes no run");

    const created = JSON.stringify({ type: "contact.created", data: { id: ctx.nonce } });
    const presetOk = await deliver(presetId, created, {
      "X-Hub-Signature-256": sign(created),
    });
    expectStatus(presetOk, [201], "standard-webhooks preset starts a matching event type");
    const presetRun = await waitForRun(
      ctx,
      String(asRecord(presetOk.json).runId),
      "completed",
      20_000,
      "preset webhook run",
    );
    expect(
      asRecord(presetRun.run.triggerData).type === "contact.created",
      "the preset delivery keeps the event type on the run",
    );
    expect(
      presetRun.steps.some((step) => step.nodeId === "note" && step.status === "completed"),
      `the preset delivery executed the script step: ${JSON.stringify(presetRun.steps)}`,
    );
    expect(runCount(ctx, presetId) === 1, "the matching preset delivery is the only persisted run");
  },
};
