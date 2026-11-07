/**
 * A resolved approval edits its Slack card in place: one chat.update per card
 * on the final terminal transition, never twice, never throwing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlink } from "node:fs/promises";

type UpdateCall = { channel: string; ts: string; text: string; blocks: unknown[] };
const updates: UpdateCall[] = [];
let failUpdates = false;
const update = mock(async (args: UpdateCall) => {
  updates.push(args);
  if (failUpdates) throw new Error("slack down xoxb-123456789012-abcdefghijkl");
  return { ok: true };
});
const postMessage = mock(async (_args: Record<string, unknown>) => ({
  ts: "1700000000.000200",
  channel: "D0DM",
}));
const conversationsOpen = mock(async ({ users }: { users: string }) => ({
  ok: true,
  channel: { id: `D${users}` },
}));
mock.module("../slack/app", () => ({
  getSlackApp: () => ({
    client: { chat: { update, postMessage }, conversations: { open: conversationsOpen } },
  }),
}));

import {
  type ApprovalRequest,
  cancelApprovalRequestById,
  cancelPendingApprovalRequestsForRun,
  closeDb,
  createApprovalRequest,
  createUser,
  createWorkflow,
  createWorkflowRun,
  createWorkflowRunStep,
  getApprovalRequestById,
  initDb,
  recordApprovalVotes,
  resolveApprovalRequest,
  updateApprovalRequestNotifications,
} from "../be/db";
import {
  dispatchApprovalNotifications,
  updateResolvedApprovalCards,
} from "../workflows/approval-notifications";

const TEST_DB_PATH = "./test-approval-card-resolution.sqlite";

async function createPosted(
  overrides: Record<string, unknown> = {},
  channels: Array<Record<string, string>> = [
    { channel: "slack", target: "C0CHAN", messageTs: "1700000000.000100", channelId: "C0CHAN" },
  ],
): Promise<ApprovalRequest> {
  const approval = await createApprovalRequest({
    id: crypto.randomUUID(),
    title: "Ship <the> release",
    questions: [{ id: "q1", type: "approval", label: "Approve?", required: true }],
    approvers: { policy: "any" as const },
    timeoutSeconds: 72_000,
    ...overrides,
  });
  await updateApprovalRequestNotifications(
    approval.id,
    channels as Array<{ channel: string; target: string }>,
  );
  return approval;
}

/** The hook runs after commit, fire and forget: wait for it to settle. */
async function settle(expected: number): Promise<void> {
  for (let i = 0; i < 100 && updates.length < expected; i++) await Bun.sleep(10);
  await Bun.sleep(30);
}

function cardText(call: UpdateCall): string {
  return JSON.stringify(call.blocks);
}

beforeAll(async () => {
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) await unlink(TEST_DB_PATH + suffix).catch(() => {});
});

beforeEach(() => {
  updates.length = 0;
  conversationsOpen.mockClear();
  failUpdates = false;
});

describe("resolved approval Slack card", () => {
  test("approved: header names the responder, button is a neutral View link, no timeout", async () => {
    const user = await createUser({ name: "Taras" });
    const approval = await createPosted();
    await resolveApprovalRequest(approval.id, {
      status: "approved",
      responses: { q1: { approved: true } },
      resolvedBy: user.id,
    });
    await settle(1);

    expect(updates).toHaveLength(1);
    const call = updates[0]!;
    expect(call.channel).toBe("C0CHAN");
    expect(call.ts).toBe("1700000000.000100");
    const text = cardText(call);
    expect(text).toContain("✅ *Approved by Taras*");
    expect(text).toContain("Ship &lt;the&gt; release");
    expect(text).toContain("Approve?");
    expect(text).toContain("<!date^");
    expect(text).toContain("{date_short_pretty} {time}");
    expect(text).toContain('"text":"View"');
    expect(text).not.toContain("Review & Respond");
    expect(text).not.toContain("primary");
    expect(text).not.toContain("Timeout");
    expect(text).not.toContain("Approval Required");
  });

  test("rejected: header names the responder", async () => {
    const approval = await createPosted();
    await resolveApprovalRequest(approval.id, { status: "rejected", resolvedBy: "operator" });
    await settle(1);
    expect(updates).toHaveLength(1);
    expect(cardText(updates[0]!)).toContain("❌ *Rejected by operator*");
  });

  test("timeout: header says no response", async () => {
    const approval = await createPosted();
    await resolveApprovalRequest(approval.id, { status: "timeout", resolutionReason: "expired" });
    await settle(1);
    expect(updates).toHaveLength(1);
    expect(cardText(updates[0]!)).toContain("⏱️ *Timed out, no response*");
  });

  test("cancelled by id: header carries the reason", async () => {
    const approval = await createPosted();
    await cancelApprovalRequestById(approval.id, { reason: "Superseded by v2", resolvedBy: null });
    await settle(1);
    expect(updates).toHaveLength(1);
    expect(cardText(updates[0]!)).toContain("🚫 *Cancelled: Superseded by v2*");
  });

  test("cancelled with its run: every pending request of the run is edited", async () => {
    const workflow = await createWorkflow({
      name: `card-run-cancel-${crypto.randomUUID()}`,
      definition: { nodes: [] },
    });
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    await createWorkflowRun({ id: runId, workflowId: workflow.id });
    await createWorkflowRunStep({
      id: stepId,
      runId,
      nodeId: "approval",
      nodeType: "human-in-the-loop",
    });
    const approval = await createPosted({ workflowRunId: runId, workflowRunStepId: stepId });
    expect(approval.status).toBe("pending");

    await cancelPendingApprovalRequestsForRun(runId, "Run cancelled");
    await settle(1);
    expect(updates).toHaveLength(1);
    expect(cardText(updates[0]!)).toContain("🚫 *Cancelled: Run cancelled*");
  });

  test("a second call for the same card is a no-op", async () => {
    const approval = await createPosted();
    const resolved = await resolveApprovalRequest(approval.id, { status: "approved" });
    await settle(1);
    expect(updates).toHaveLength(1);

    await updateResolvedApprovalCards([resolved!]);
    await updateResolvedApprovalCards([(await getApprovalRequestById(approval.id))!]);
    expect(updates).toHaveLength(1);
  });

  test("a request with no messageTs or no Slack entry is untouched", async () => {
    const noTs = await createPosted({}, [{ channel: "slack", target: "C0CHAN" }]);
    const emailOnly = await createPosted({}, [{ channel: "email", target: "a@b.c" }]);
    const resolvedNoTs = await resolveApprovalRequest(noTs.id, { status: "approved" });
    const resolvedEmail = await resolveApprovalRequest(emailOnly.id, { status: "rejected" });
    await updateResolvedApprovalCards([resolvedNoTs!, resolvedEmail!]);
    await settle(0);
    expect(updates).toHaveLength(0);
  });

  test("a Slack error never fails the resolution and leaves the edit retryable", async () => {
    failUpdates = true;
    const approval = await createPosted();
    const resolved = await resolveApprovalRequest(approval.id, { status: "approved" });
    expect(resolved?.status).toBe("approved");
    await settle(1);
    expect(updates).toHaveLength(1);

    // Called directly it also resolves, not rejects; the claim was released.
    await updateResolvedApprovalCards([resolved!]);
    expect(updates).toHaveLength(2);
    expect((await getApprovalRequestById(approval.id))?.status).toBe("approved");

    failUpdates = false;
    await updateResolvedApprovalCards([resolved!]);
    expect(updates).toHaveLength(3);
    await updateResolvedApprovalCards([resolved!]);
    expect(updates).toHaveLength(3);
  });

  test("multi-quorum: recorded votes leave the card alone; only the final transition edits it", async () => {
    const approval = await createPosted({ approvers: { policy: { min: 2 } } });
    const vote = (responder: string) => ({
      responder,
      approved: true,
      responses: { q1: { approved: true } },
      respondedAt: new Date().toISOString(),
    });
    expect(await recordApprovalVotes(approval.id, [vote("u1")])).toBe(true);
    await settle(0);
    expect(updates).toHaveLength(0);

    await resolveApprovalRequest(approval.id, {
      status: "approved",
      approvals: [vote("u1"), vote("u2")],
      resolvedBy: "operator",
    });
    await settle(1);
    expect(updates).toHaveLength(1);
    expect(cardText(updates[0]!)).toContain("✅ *Approved by operator*");
  });

  test("a resolution that lands while the card posts edits it once the messageTs is stored", async () => {
    const approval = await createPosted({}, []);
    await resolveApprovalRequest(approval.id, { status: "approved", resolvedBy: "operator" });
    await settle(0);
    expect(updates).toHaveLength(0);

    await dispatchApprovalNotifications({
      requestId: approval.id,
      title: approval.title,
      questions: approval.questions as Array<{ label?: string }>,
      notifications: [{ channel: "slack", target: "U0USER" }],
    });
    await settle(1);
    expect(updates).toHaveLength(1);
    // The DM conversation id from chat.postMessage, not the user-id target.
    expect(updates[0]!.channel).toBe("D0DM");
    expect(cardText(updates[0]!)).toContain("✅ *Approved by operator*");
  });

  test("a DM card stored before channelId existed is edited in the bot's DM with the user", async () => {
    // The pre-deploy entry shape: a user-id target and the messageTs, no conversation id.
    const user = await createPosted({}, [
      { channel: "slack", target: "U0LEGACY", messageTs: "1700000000.000300" },
    ]);
    const grid = await createPosted({}, [
      { channel: "slack", target: "W0GRID", messageTs: "1700000000.000400" },
    ]);
    await resolveApprovalRequest(user.id, { status: "approved", resolvedBy: "operator" });
    await resolveApprovalRequest(grid.id, { status: "rejected", resolvedBy: "operator" });
    await settle(2);

    expect(updates).toHaveLength(2);
    const byTs = Object.fromEntries(updates.map((u) => [u.ts, u]));
    expect(byTs["1700000000.000300"]?.channel).toBe("DU0LEGACY");
    expect(byTs["1700000000.000400"]?.channel).toBe("DW0GRID");
    expect(conversationsOpen).toHaveBeenCalledWith({ users: "U0LEGACY" });
    expect(conversationsOpen).toHaveBeenCalledWith({ users: "W0GRID" });
  });

  test("a stored channelId or a channel target never opens a DM", async () => {
    await resolveApprovalRequest((await createPosted()).id, { status: "approved" });
    await settle(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.channel).toBe("C0CHAN");
    expect(conversationsOpen).not.toHaveBeenCalled();
  });
});
