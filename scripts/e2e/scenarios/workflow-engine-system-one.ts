// SystemOne in the workflow engine: the save warning and the run-start gate when a
// provider is not configured, the `system-one-decide` tool, a decision with a human
// review band (approved with an override, rejected, out of band), and the
// system-one-extraction node.
//
// The extraction node can only reach Cloudflare Workers AI (a fixed host), so a black box
// cannot serve it from the mock inference host. The scenario proves everything up to the
// outbound call: the readiness gate, authoring rules, and a step row that fails on its
// strict `{{token}}` check before any request would leave the process.
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  createWorkflow,
  getRunDetail,
  outputOf,
  pointLayaAtMock,
  registerWorker,
  respondApproval,
  setGlobalConfig,
  stepOf,
  systemOneDecisionAnswer,
  triggerWorkflow,
  type WorkflowDef,
  waitForApproval,
  waitForRun,
} from "./workflow-helpers";

const TEAM_QUESTION = {
  type: "choice",
  instructions: "Which team handles it?",
  criteria: { billing: "Charges", technical: "Bugs and outages" },
};

function decisionNode(extra: Record<string, unknown> = {}, next?: Record<string, string>) {
  return {
    id: "decide",
    type: "system-one-decision",
    inputs: { lead: "trigger.lead" },
    config: {
      provider: "laya",
      state: "{{lead}}",
      questions: { team: TEAM_QUESTION },
      returns: { team: { type: "choice" } },
      maxRetries: 0,
      ...extra,
    },
    next,
  };
}

function extractionNode(state: string) {
  return {
    id: "extract",
    type: "system-one-extraction",
    config: {
      state,
      fields: { order_id: { type: "text", instructions: "Order number" } },
      maxRetries: 0,
      timeoutMs: 2000,
    },
  };
}

export const workflowEngineSystemOne: Scenario = {
  name: "workflow-engine-system-one",
  order: 325,
  async run(ctx) {
    const marker = `s1-${ctx.nonce}`;
    const workerId = await registerWorker(ctx, "wf-s1");
    const connection = await ctx.connectMcp(workerId);
    const cleanups: Array<() => Promise<void>> = [];
    const workflows: string[] = [];
    const track = async (name: string, definition: WorkflowDef) => {
      const id = await createWorkflow(ctx, name, definition, {}, workerId);
      workflows.push(id);
      return id;
    };

    try {
      // ── not configured: warn at save, refuse at run start ───────────────────
      const decisionOnly: WorkflowDef = { nodes: [decisionNode()] };
      const unconfigured = await ctx.api("POST", "/api/workflows", {
        agentId: workerId,
        body: { name: `wf-s1-unconfigured-${ctx.nonce}`, definition: decisionOnly },
      });
      expectStatus(unconfigured, [201], "save a decision workflow without a laya setup");
      const unconfiguredBody = asRecord(unconfigured.json);
      workflows.push(asString(unconfiguredBody.id, "workflow id"));
      const warnings = unconfiguredBody.warnings;
      expect(
        Array.isArray(warnings) && warnings.some((warning) => String(warning).includes("LAYA")),
        `save warns that laya is not configured: ${JSON.stringify(warnings)}`,
      );

      const viaTool = await callToolOk(connection, "create-workflow", {
        name: `wf-s1-tool-${ctx.nonce}`,
        definition: decisionOnly,
      });
      workflows.push(asString(asRecord(viaTool.structured.workflow).id, "tool workflow id"));
      expect(
        Array.isArray(viaTool.structured.warnings) &&
          viaTool.structured.warnings.some((warning) => String(warning).includes("LAYA")),
        "create-workflow reports the same warning in data.warnings",
      );

      const blocked = await triggerWorkflow(
        ctx,
        workflows[0] as string,
        { lead: { message: "hi" } },
        { agentId: workerId },
      );
      const blockedRun = await waitForRun(ctx, blocked.runId, "failed", 15_000, "gated run");
      expect(blockedRun.steps.length === 0, "a gated run executes no node");
      expect(
        String(blockedRun.run.error).includes("LAYA"),
        `the gated run names the missing setting: ${String(blockedRun.run.error)}`,
      );

      const unconfiguredTool = await callToolErr(
        connection,
        "system-one-decide",
        { provider: "laya", state: "x", questions: { q: { type: "noul", instructions: "ok?" } } },
        "LAYA",
      );
      expect(unconfiguredTool.structured.providerUnavailable !== true, "laya is only unconfigured");
      // OpenRouter refuses a gateway base URL (the SUT points OPENROUTER_BASE_URL at the mock).
      const refused = await callToolErr(connection, "system-one-decide", {
        provider: "openrouter",
        state: "x",
        questions: { q: { type: "noul", instructions: "ok?" } },
      });
      expect(
        refused.structured.providerUnavailable === true,
        "a deployment-refused provider reports providerUnavailable",
      );
      await callToolErr(
        connection,
        "system-one-decide",
        {
          provider: "typesafe",
          state: "x",
          questions: { q: { type: "noul", instructions: "ok?" } },
        },
        "TYPESAFE_API_KEY",
      );

      // ── extraction: warn, gate, authoring rules ─────────────────────────────
      const extractionOnly: WorkflowDef = { nodes: [extractionNode("an order mail")] };
      const extractionSaved = await ctx.api("POST", "/api/workflows", {
        agentId: workerId,
        body: { name: `wf-s1-extract-${ctx.nonce}`, definition: extractionOnly },
      });
      expectStatus(extractionSaved, [201], "save an extraction workflow without Cloudflare");
      const extractionId = asString(asRecord(extractionSaved.json).id, "extraction workflow id");
      workflows.push(extractionId);
      const extractionWarnings = asRecord(extractionSaved.json).warnings;
      expect(
        Array.isArray(extractionWarnings) &&
          extractionWarnings.some((warning) => String(warning).includes("CLOUDFLARE")),
        `save warns that Cloudflare is not configured: ${JSON.stringify(extractionWarnings)}`,
      );
      const gated = await triggerWorkflow(ctx, extractionId, {}, { agentId: workerId });
      const gatedRun = await waitForRun(ctx, gated.runId, "failed", 15_000, "gated extraction run");
      expect(
        gatedRun.steps.length === 0 && String(gatedRun.run.error).includes("CLOUDFLARE"),
        `extraction run is gated before any node: ${String(gatedRun.run.error)}`,
      );

      const withRetry = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `wf-s1-retry-${ctx.nonce}`,
          definition: { nodes: [{ ...extractionNode("x"), retry: { maxRetries: 1 } }] },
        },
      });
      expectStatus(withRetry, [400], "a system-one node with an engine retry policy");
      expect(String(asRecord(withRetry.json).error).includes("retry"), "retry rule is explained");
      const badField = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `wf-s1-field-${ctx.nonce}`,
          definition: {
            nodes: [
              {
                ...extractionNode("x"),
                config: { state: "x", fields: { "bad.id": { type: "text" } } },
              },
            ],
          },
        },
      });
      expectStatus(badField, [400], "an extraction field id with a dot");
      const stringNext = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `wf-s1-next-${ctx.nonce}`,
          definition: {
            nodes: [
              {
                ...decisionNode({
                  humanReview: { band: { min: 0.5, max: 0.8 }, approvers: { policy: "any" } },
                }),
                next: "after",
              },
              { id: "after", type: "script", config: { runtime: "bash", script: "echo x" } },
            ],
          },
        },
      });
      expectStatus(stringNext, [400], "humanReview needs a port map next");

      // ── configured: the decide tool ─────────────────────────────────────────
      cleanups.push(await pointLayaAtMock(ctx));
      ctx.llm.setSystemOneResponder((body) =>
        systemOneDecisionAnswer(body, { choice: { team: "technical" }, confidence: { team: 0.9 } }),
      );
      const decided = await callToolOk(connection, "system-one-decide", {
        provider: "laya",
        state: { message: `tool call ${marker}` },
        questions: {
          team: TEAM_QUESTION,
          fit: { type: "noul", instructions: "A real lead?" },
        },
        maxRetries: 0,
      });
      const toolAnswers = asRecord(decided.structured.answers);
      expect(
        asRecord(toolAnswers.team).choice === "technical" &&
          asRecord(toolAnswers.fit).type === "noul",
        `decide tool answers: ${JSON.stringify(toolAnswers)}`,
      );
      expect(
        decided.structured.model === "laya-rl-agent" &&
          typeof decided.structured.requestId === "string" &&
          asRecord(decided.structured.usage).input_tokens === 12,
        "decide tool reports model, request id and usage",
      );
      const seen = ctx.llm.requestsTo("/systemone").at(-1);
      expect(
        seen?.headers.authorization === "Bearer e2e-laya-key" &&
          JSON.stringify(asRecord(seen.body).state).includes(marker) &&
          !("model" in asRecord(seen.body)),
        "decide tool sent the key and state, and no model (laya has no default)",
      );
      await callToolErr(
        connection,
        "system-one-decide",
        { provider: "laya", state: "x", questions: { q: { type: "bogus", instructions: "x" } } },
        "Invalid decision request",
      );
      ctx.llm.setSystemOneResponder(() => ({
        model: "laya-rl-agent",
        answers: {},
        usage: { input_tokens: 1, output_tokens: 0 },
      }));
      await callToolErr(
        connection,
        "system-one-decide",
        {
          provider: "laya",
          state: "x",
          questions: { team: TEAM_QUESTION },
          maxRetries: 0,
        },
        "team",
      );

      // ── human review band ───────────────────────────────────────────────────
      const reviewFlow: WorkflowDef = {
        nodes: [
          decisionNode(
            {
              humanReview: {
                band: { min: 0.5, max: 0.8 },
                approvers: { policy: "any" },
                title: `Check the lead ${marker}`,
              },
            },
            { approved: "ok", rejected: "no", timeout: "no" },
          ),
          {
            id: "ok",
            type: "script",
            inputs: { d: "decide" },
            config: {
              runtime: "bash",
              script: "echo team-$0",
              args: ["{{d.answers.team.choice}}"],
            },
          },
          { id: "no", type: "script", config: { runtime: "bash", script: "echo discarded" } },
        ],
      };
      const reviewId = await track("wf-s1-review", reviewFlow);
      const lead = { lead: { message: `please help ${marker}` } };

      // In band (0.7): the node parks, a person overrides the team.
      ctx.llm.setSystemOneResponder((body) =>
        systemOneDecisionAnswer(body, { choice: { team: "technical" }, confidence: { team: 0.7 } }),
      );
      const approvedRun = await triggerWorkflow(ctx, reviewId, lead, { agentId: workerId });
      const card = await waitForApproval(ctx, approvedRun.runId);
      expect(card.title === `Check the lead ${marker}`, "review card keeps the node title");
      const cardQuestions = asRecords(card, "questions");
      expect(
        cardQuestions[0]?.id === "$confirm" &&
          cardQuestions[0]?.type === "approval" &&
          cardQuestions[1]?.id === "team" &&
          cardQuestions[1]?.type === "single-select",
        `review card questions: ${JSON.stringify(cardQuestions.map((q) => [q.id, q.type]))}`,
      );
      expect(
        asRecords(cardQuestions[1] ?? {}, "options")
          .map((o) => o.value)
          .join(",") === "billing,technical",
        "the select offers the node's options",
      );
      expect(
        (await getRunDetail(ctx, approvedRun.runId)).run.status === "waiting",
        "the run waits for the reviewer",
      );
      await respondApproval(ctx, String(card.id), {
        $confirm: { approved: true },
        team: "billing",
      });
      const approvedDetail = await waitForRun(
        ctx,
        approvedRun.runId,
        "completed",
        30_000,
        "approved review",
      );
      const reviewed = outputOf(approvedDetail, "decide");
      expect(stepOf(approvedDetail, "decide").nextPort === "approved", "decision left by approved");
      expect(
        asRecord(asRecord(reviewed.answers).team).choice === "billing",
        "the person's choice replaced the model's",
      );
      const review = asRecord(reviewed.review);
      expect(
        review.status === "approved" && review.approvalRequestId === card.id,
        `review block: ${JSON.stringify(review)}`,
      );
      const teamReview = asRecord(asRecord(review.questions).team);
      expect(
        teamReview.inBand === true &&
          teamReview.decidedBy === "human" &&
          teamReview.modelAnswer === "technical" &&
          teamReview.confidence === 0.7,
        `the override stays auditable: ${JSON.stringify(teamReview)}`,
      );
      expect(
        outputOf(approvedDetail, "ok").stdout === "team-billing",
        "downstream saw the override",
      );

      // Rejected: the model's answer stays, the node leaves by `rejected`.
      const rejectedRun = await triggerWorkflow(ctx, reviewId, lead, { agentId: workerId });
      const rejectedCard = await waitForApproval(ctx, rejectedRun.runId);
      await respondApproval(ctx, String(rejectedCard.id), { $confirm: { approved: false } });
      const rejectedDetail = await waitForRun(
        ctx,
        rejectedRun.runId,
        "completed",
        30_000,
        "rejected review",
      );
      expect(stepOf(rejectedDetail, "decide").nextPort === "rejected", "decision left by rejected");
      const rejectedOut = outputOf(rejectedDetail, "decide");
      expect(
        asRecord(asRecord(rejectedOut.answers).team).choice === "technical" &&
          asRecord(rejectedOut.review).status === "rejected",
        "a rejection keeps the model's answer",
      );
      expect(outputOf(rejectedDetail, "no").stdout === "discarded", "rejected branch ran");

      // Out of band (0.95): no card, the answer passes straight through.
      ctx.llm.setSystemOneResponder((body) =>
        systemOneDecisionAnswer(body, {
          choice: { team: "technical" },
          confidence: { team: 0.95 },
        }),
      );
      const passRun = await triggerWorkflow(ctx, reviewId, lead, { agentId: workerId });
      const passDetail = await waitForRun(ctx, passRun.runId, "completed", 30_000, "out of band");
      const passOut = outputOf(passDetail, "decide");
      expect(asRecord(passOut.review).status === "not_required", "no review needed out of band");
      expect(outputOf(passDetail, "ok").stdout === "team-technical", "answer passed through");
      const cards = await ctx.api("GET", `/api/approval-requests?workflowRunId=${passRun.runId}`);
      expect(asRecords(cards.json, "approvalRequests").length === 0, "no approval card was raised");

      // ── extraction: configured, strict token check, no outbound call ────────
      cleanups.push(
        await setGlobalConfig(ctx, "CLOUDFLARE_ACCOUNT_ID", "0123456789abcdef0123456789abcdef"),
      );
      cleanups.push(
        await setGlobalConfig(ctx, "CLOUDFLARE_API_TOKEN", "e2e-cloudflare-token", true),
      );
      // Not tracked for cleanup: deleting a workflow deletes its runs, and the coverage
      // report reads node types from the step rows that survive the run.
      const extractFlow = await createWorkflow(
        ctx,
        "wf-s1-extract-run",
        { nodes: [extractionNode("{{ghost.value}}")] },
        {},
        workerId,
      );
      const decisionCallsBefore = ctx.llm.requestsTo("/systemone").length;
      const extractRun = await triggerWorkflow(ctx, extractFlow, {}, { agentId: workerId });
      const extractDetail = await waitForRun(
        ctx,
        extractRun.runId,
        "failed",
        20_000,
        "extraction run",
      );
      const extractStep = stepOf(extractDetail, "extract");
      expect(
        extractStep.status === "failed" && String(extractStep.error).includes("ghost.value"),
        `extraction step fails on its unresolved token: ${String(extractStep.error)}`,
      );
      const stepRow = ctx.db.get<{ nodeType: string }>(
        "SELECT nodeType FROM workflow_run_steps WHERE runId = ? AND nodeId = 'extract'",
        [extractRun.runId],
      );
      expect(stepRow?.nodeType === "system-one-extraction", "the step row has the extraction type");
      expect(
        ctx.llm.requestsTo("/systemone").length === decisionCallsBefore,
        "the failed token check sent nothing to a SystemOne host",
      );
    } finally {
      ctx.llm.setSystemOneResponder(undefined);
      for (const cleanup of cleanups.reverse()) await cleanup();
      for (const id of workflows) await ctx.api("DELETE", `/api/workflows/${id}`);
      await connection.close();
    }
  },
};
