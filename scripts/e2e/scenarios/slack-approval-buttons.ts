import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  createWorkflow,
  registerWorker,
  respondApproval,
  stepOf,
  triggerWorkflow,
  waitForApproval,
  waitForRun,
} from "./workflow-helpers";

const CHANNEL = "C0GENERAL0";

async function getApproval(ctx: ScenarioContext, id: string): Promise<Record<string, unknown>> {
  const response = await ctx.api("GET", `/api/approval-requests/${id}`);
  expectStatus(response, [200], `read approval ${id}`);
  return asRecord(asRecord(response.json).approvalRequest);
}

/** The pending card for `title`, once the HITL step has posted it. */
async function waitForCard(
  ctx: ScenarioContext,
  title: string,
): Promise<{ ts: string; raw: string }> {
  const card = await ctx.slack.waitForMessage(
    (message) => message.channel === CHANNEL && JSON.stringify(message).includes(title),
    { timeoutMs: 15_000 },
  );
  return { ts: card.ts, raw: JSON.stringify(card) };
}

async function waitForEphemeral(
  ctx: ScenarioContext,
  slackUserId: string,
  pattern: RegExp,
  label: string,
  /** Only ephemerals posted after this many. */
  after: number,
): Promise<void> {
  const seen = await pollUntil(
    () =>
      ctx.slack
        .ephemeralMessages(CHANNEL)
        .slice(after)
        .some((m) => JSON.stringify(m).includes(slackUserId) && pattern.test(m.text ?? "")),
    15_000,
  );
  expect(
    seen,
    `${label}: no ephemeral matching ${pattern} for ${slackUserId}: ${JSON.stringify(
      ctx.slack.ephemeralMessages(CHANNEL).slice(-5),
    ).slice(0, 1500)}`,
  );
}

async function waitForCardOutcome(
  ctx: ScenarioContext,
  ts: string,
  outcome: RegExp,
  label: string,
): Promise<void> {
  const current = () => JSON.stringify(ctx.slack.messages(CHANNEL).find((m) => m.ts === ts) ?? {});
  const updated = await pollUntil(
    () => outcome.test(current()) && !current().includes("hitl_answer:"),
    15_000,
  );
  expect(updated, `${label}: card ${ts} not edited to ${outcome}: ${current().slice(0, 1500)}`);
}

/**
 * Inline approval buttons on the Slack card: a linked approver resolves the run
 * with one click, an unlinked user is refused and nothing changes, a click on a
 * resolved request (twice, or after a dashboard answer) only re-renders, and
 * Deny opens a modal whose reason is stored.
 */
export const slackApprovalButtons: Scenario = {
  name: "slack-approval-buttons",
  // Next to workflow-approvals (340), on the default Socket Mode Slack mock.
  order: 340.5,
  async run(ctx) {
    const tag = ctx.nonce
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    const approverSlackId = `U0APR${tag}`;
    const strangerSlackId = `U0STR${tag}`;
    ctx.slack.addUser({ id: approverSlackId, name: `approver-${tag.toLowerCase()}` });
    ctx.slack.addUser({ id: strangerSlackId, name: `stranger-${tag.toLowerCase()}` });
    ctx.slack.invite(CHANNEL, [approverSlackId, strangerSlackId]);

    const created = await ctx.api("POST", "/api/users", {
      body: {
        name: `Inline Approver ${ctx.nonce}`,
        email: `inline-approver-${ctx.nonce}@example.com`,
        identities: [{ kind: "slack", externalId: approverSlackId }],
      },
    });
    expectStatus(created, [200, 201], "create the linked approver");
    const approverUserId = asString(asRecord(asRecord(created.json).user).id, "approver id");

    const workerId = await registerWorker(ctx, "inline-appr");
    const workflow = (title: string, questions: unknown[]) => ({
      nodes: [
        {
          id: "ask",
          type: "human-in-the-loop",
          config: {
            title,
            questions,
            approvers: { policy: "any" },
            notifications: [{ channel: "slack", target: CHANNEL }],
          },
          next: { approved: "yes", rejected: "no", timeout: "no" },
        },
        { id: "yes", type: "script", config: { runtime: "bash", script: "echo yes" } },
        { id: "no", type: "script", config: { runtime: "bash", script: "echo no" } },
      ],
    });
    const ship = [{ id: "ship", type: "approval", label: "Ship it?" }];

    // ── Approve: refused for an unlinked user, then one click resolves ────────
    const approveTitle = `Inline approve ${ctx.nonce}`;
    const approveId = await createWorkflow(
      ctx,
      "inline-approve",
      workflow(approveTitle, ship),
      {},
      workerId,
    );
    const approveRun = await triggerWorkflow(ctx, approveId, {}, { agentId: workerId });
    const approval = await waitForApproval(ctx, approveRun.runId);
    const approvalId = String(approval.id);
    const card = await waitForCard(ctx, approveTitle);
    expect(
      card.raw.includes('"hitl_answer:y"') &&
        card.raw.includes('"hitl_answer:n"') &&
        card.raw.includes(`/approval-requests/${approvalId}`),
      `the card has Approve, Deny and the dashboard link: ${card.raw.slice(0, 1500)}`,
    );

    const seen0 = ctx.slack.ephemeralMessages(CHANNEL).length;
    await ctx.slack.clickButton({
      channel: CHANNEL,
      ts: card.ts,
      action_id: "hitl_answer:y",
      value: approvalId,
      user: strangerSlackId,
    });
    await waitForEphemeral(ctx, strangerSlackId, /not linked/, "unlinked click", seen0);
    expect(
      (await getApproval(ctx, approvalId)).status === "pending",
      "an unlinked click changes nothing",
    );

    await ctx.slack.clickButton({
      channel: CHANNEL,
      ts: card.ts,
      action_id: "hitl_answer:y",
      value: approvalId,
      user: approverSlackId,
    });
    const approved = await waitForRun(ctx, approveRun.runId, "completed", 30_000, "inline approve");
    expect(stepOf(approved, "ask").nextPort === "approved", "the click routed on approved");
    const approvedRow = await getApproval(ctx, approvalId);
    const vote = asRecords(approvedRow, "approvals")[0] ?? {};
    expect(
      approvedRow.status === "approved" &&
        approvedRow.resolvedBy === approverUserId &&
        vote.responder === approverUserId &&
        asRecord(vote.via).channel === "slack" &&
        asRecord(vote.via).platformUserId === approverSlackId,
      `the vote records the mapped user and the Slack clicker: ${JSON.stringify(approvedRow)}`,
    );
    await waitForCardOutcome(ctx, card.ts, /Approved/, "approved card");

    // A second click on the resolved request only re-renders.
    const seen2 = ctx.slack.ephemeralMessages(CHANNEL).length;
    await ctx.slack.clickButton({
      channel: CHANNEL,
      ts: card.ts,
      action_id: "hitl_answer:n",
      value: approvalId,
      user: approverSlackId,
    });
    await waitForEphemeral(ctx, approverSlackId, /already approved/, "double click", seen2);
    expect(
      (await getApproval(ctx, approvalId)).status === "approved",
      "a late Deny does not flip an approved request",
    );

    // ── Deny: the modal's reason is stored on the answer ─────────────────────
    const denyTitle = `Inline deny ${ctx.nonce}`;
    const denyId = await createWorkflow(
      ctx,
      "inline-deny",
      workflow(denyTitle, ship),
      {},
      workerId,
    );
    const denyRun = await triggerWorkflow(ctx, denyId, {}, { agentId: workerId });
    const denial = await waitForApproval(ctx, denyRun.runId);
    const denyCard = await waitForCard(ctx, denyTitle);
    await ctx.slack.clickButton({
      channel: CHANNEL,
      ts: denyCard.ts,
      action_id: "hitl_answer:n",
      value: String(denial.id),
      user: approverSlackId,
    });
    const opened = await pollUntil(() => ctx.slack.apiCalls("views.open").length > 0, 15_000);
    expect(opened, "Deny opens the reason modal");
    await ctx.slack.submitView({
      callback_id: "hitl_answer_modal",
      user: approverSlackId,
      values: { answer: { text: { type: "plain_text_input", value: "too risky" } } },
    });
    const denied = await waitForRun(ctx, denyRun.runId, "completed", 30_000, "inline deny");
    expect(stepOf(denied, "ask").nextPort === "rejected", "the modal routed on rejected");
    const deniedRow = await getApproval(ctx, String(denial.id));
    expect(
      deniedRow.status === "rejected" &&
        JSON.stringify(asRecord(deniedRow.responses).ship) ===
          JSON.stringify({ approved: false, comment: "too risky" }),
      `the reason is stored: ${JSON.stringify(deniedRow.responses)}`,
    );
    await waitForCardOutcome(ctx, denyCard.ts, /Rejected/, "rejected card");

    // ── Complex request: dashboard only; a click after a UI answer re-renders ─
    const formTitle = `Inline form ${ctx.nonce}`;
    const formId = await createWorkflow(
      ctx,
      "inline-form",
      workflow(formTitle, [...ship, { id: "note", type: "text", label: "Note", required: false }]),
      {},
      workerId,
    );
    const formRun = await triggerWorkflow(ctx, formId, {}, { agentId: workerId });
    const form = await waitForApproval(ctx, formRun.runId);
    const formCard = await waitForCard(ctx, formTitle);
    expect(
      !formCard.raw.includes("hitl_answer:"),
      `a two-question card has no inline buttons: ${formCard.raw.slice(0, 1500)}`,
    );
    await respondApproval(ctx, String(form.id), { ship: { approved: true } });
    await waitForRun(ctx, formRun.runId, "completed", 30_000, "dashboard answer");
    const seen4 = ctx.slack.ephemeralMessages(CHANNEL).length;
    await ctx.slack.clickButton({
      channel: CHANNEL,
      ts: formCard.ts,
      action_id: "hitl_answer:n",
      value: String(form.id),
      user: approverSlackId,
    });
    await waitForEphemeral(
      ctx,
      approverSlackId,
      /already approved/,
      "click after a UI answer",
      seen4,
    );
    expect(
      (await getApproval(ctx, String(form.id))).status === "approved",
      "a click after the dashboard answer changes nothing",
    );
  },
};
