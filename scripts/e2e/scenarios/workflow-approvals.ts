// Approval requests: the REST contract (create, read, list, answer, cancel), who may
// answer and how many answers a policy needs, the late-answer timeout, the MCP tools
// agents use to ask a person, and approval cards raised by workflow nodes.
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  approvalsForRun,
  callToolErr,
  callToolOk,
  createWorkflow,
  getRunDetail,
  hasStep,
  outputOf,
  registerWorker,
  respondApproval,
  stepOf,
  triggerWorkflow,
  waitForApproval,
  waitForRun,
} from "./workflow-helpers";

const GO = { id: "go", type: "approval", label: "Go?", required: true };

function request(extra: Record<string, unknown> = {}) {
  return {
    title: "E2E approval",
    questions: [GO],
    approvers: { policy: "any" },
    ...extra,
  };
}

async function createRequest(
  ctx: Parameters<Scenario["run"]>[0],
  body: Record<string, unknown>,
  options: { agentId?: string } = {},
): Promise<Record<string, unknown>> {
  const response = await ctx.api("POST", "/api/approval-requests", {
    body,
    agentId: options.agentId,
  });
  expectStatus(response, [201], "create approval request");
  return asRecord(asRecord(response.json).approvalRequest);
}

export const workflowApprovals: Scenario = {
  name: "workflow-approvals",
  order: 340,
  async run(ctx) {
    const marker = `appr-${ctx.nonce}`;
    const workerId = await registerWorker(ctx, "wf-appr");
    const otherId = await registerWorker(ctx, "wf-appr-other");
    let settleTasks = false;
    const sim = await ctx.startAgent({
      agentId: workerId,
      // Tasks stay in progress (so the agent has a "current task") until released.
      onTask: ({ taskId }) =>
        settleTasks ? { status: "completed", output: `done ${taskId}` } : { status: "ignore" },
    });
    const connection = await ctx.connectMcp(workerId);
    const otherConnection = await ctx.connectMcp(otherId);

    try {
      // ── create: contract and validation ─────────────────────────────────────
      expectStatus(
        await ctx.api("POST", "/api/approval-requests", { apiKey: null, body: request() }),
        [401],
        "create without credentials",
      );
      for (const [label, body] of [
        ["no questions", request({ questions: [] })],
        ["an empty title", request({ title: "" })],
        ["no approvers", { title: "x", questions: [GO] }],
        [
          "an unknown question type",
          request({ questions: [{ id: "q", type: "bogus", label: "q" }] }),
        ],
        [
          "a config block on a text question",
          request({
            questions: [
              { id: "q", type: "text", label: "q", config: { key: "X", scope: "global" } },
            ],
          }),
        ],
        ["a question with no label", request({ questions: [{ id: "q", type: "text" }] })],
      ] as const) {
        expectStatus(
          await ctx.api("POST", "/api/approval-requests", { body }),
          [400],
          `create with ${label}`,
        );
      }

      // `required` defaults to true, so a question that does not set it must be answered.
      const lax = await createRequest(
        ctx,
        request({ questions: [{ id: "go", type: "approval", label: "Go?" }] }),
      );
      expect(asRecords(lax, "questions")[0]?.required === true, "required defaults to true");
      const emptyAnswer = await respondApproval(ctx, String(lax.id), {}, 400);
      expect(String(emptyAnswer.error).includes("go"), "an empty answer names the question");
      expect(
        asRecord(
          asRecord((await ctx.api("GET", `/api/approval-requests/${String(lax.id)}`)).json)
            .approvalRequest,
        ).status === "pending",
        "the rejected empty answer left the request pending",
      );

      // An answered optional question is validated like a required one.
      const optionalSelect = await createRequest(
        ctx,
        request({
          questions: [
            GO,
            {
              id: "color",
              type: "single-select",
              label: "Color",
              required: false,
              options: [{ value: "red", label: "Red" }],
            },
          ],
        }),
      );
      const outOfRange = await respondApproval(
        ctx,
        String(optionalSelect.id),
        { go: { approved: true }, color: "green" },
        400,
      );
      expect(
        String(outOfRange.error).includes("color"),
        "an optional select answer outside its options is refused",
      );
      const unanswered = asRecord(
        (await respondApproval(ctx, String(optionalSelect.id), { go: { approved: true } }))
          .approvalRequest,
      );
      expect(unanswered.status === "approved", "an unanswered optional question stays allowed");

      const created = await createRequest(
        ctx,
        request({
          title: `Ship ${marker}`,
          questions: [
            GO,
            { id: "why", type: "text", label: "Why?", required: false, multiline: true },
            {
              id: "color",
              type: "single-select",
              label: "Color",
              required: true,
              options: [
                { value: "red", label: "Red" },
                { value: "blue", label: "Blue" },
              ],
            },
            {
              id: "tags",
              type: "multi-select",
              label: "Tags",
              required: true,
              minSelections: 1,
              maxSelections: 2,
              options: [
                { value: "a", label: "A" },
                { value: "b", label: "B" },
                { value: "c", label: "C" },
              ],
            },
            { id: "flag", type: "boolean", label: "Flag?", required: true },
          ],
        }),
      );
      const id = asString(created.id, "request id");
      expect(
        created.status === "pending" &&
          created.title === `Ship ${marker}` &&
          created.workflowRunId === null &&
          created.sourceTaskId === null &&
          created.expiresAt === null &&
          created.resolvedBy === null &&
          created.responses === null,
        `a new request is pending and detached: ${JSON.stringify(created)}`,
      );
      expect(
        asRecord(created.approvalProgress).approved === 0 &&
          asRecord(created.approvalProgress).required === 1,
        "a pending request reports quorum progress",
      );
      expect(asRecords(created, "questions").length === 5, "all questions are stored");
      const stored = ctx.db.get<{ status: string; title: string }>(
        "SELECT status, title FROM approval_requests WHERE id = ?",
        [id],
      );
      expect(stored?.status === "pending" && stored.title === `Ship ${marker}`, "row persisted");

      // ── read and list ───────────────────────────────────────────────────────
      const got = await ctx.api("GET", `/api/approval-requests/${id}`);
      expectStatus(got, [200], "get approval request");
      expect(asRecord(asRecord(got.json).approvalRequest).id === id, "get returns the request");
      expectStatus(
        await ctx.api("GET", `/api/approval-requests/${crypto.randomUUID()}`),
        [404],
        "get unknown request",
      );
      expectStatus(
        await ctx.api("GET", "/api/approval-requests/not-a-uuid"),
        [400],
        "get with a malformed id",
      );
      const pending = await ctx.api("GET", "/api/approval-requests?status=pending&limit=500");
      expectStatus(pending, [200], "list pending requests");
      expect(
        asRecords(pending.json, "approvalRequests").some((entry) => entry.id === id),
        "pending filter finds the request",
      );
      const slim = await ctx.api(
        "GET",
        "/api/approval-requests?fields=slim&status=pending&limit=500",
      );
      expectStatus(slim, [200], "list slim");
      const slimRow = asRecords(slim.json, "approvalRequests").find((entry) => entry.id === id);
      expect(
        slimRow &&
          slimRow.questionCount === 5 &&
          !("questions" in slimRow) &&
          asRecord(slimRow.approvalProgress).required === 1,
        `slim rows carry questionCount and progress, not questions: ${JSON.stringify(slimRow)}`,
      );
      const limited = await ctx.api("GET", "/api/approval-requests?limit=1");
      expect(asRecords(limited.json, "approvalRequests").length === 1, "limit caps the list");

      // ── answer: who, what, how ──────────────────────────────────────────────
      expectStatus(
        await ctx.api("POST", `/api/approval-requests/${id}/respond`, {
          apiKey: null,
          body: { responses: { go: { approved: true } } },
        }),
        [401],
        "respond without credentials",
      );
      const byAgent = await ctx.api("POST", `/api/approval-requests/${id}/respond`, {
        agentId: workerId,
        body: { responses: { go: { approved: true } } },
      });
      expectStatus(byAgent, [403], "an agent cannot answer");
      expect(
        String(asRecord(byAgent.json).error).includes("Agents cannot answer"),
        "the refusal says agents cannot answer",
      );
      const missing = await ctx.api("POST", `/api/approval-requests/${id}/respond`, {
        body: { responses: { why: "no go" } },
      });
      expectStatus(missing, [400], "respond without the required answer");
      expect(String(asRecord(missing.json).error).includes("go"), "names the missing question");
      const base = { go: { approved: true }, color: "blue", tags: ["a"], flag: true };
      for (const [label, responses, needle] of [
        ["a select value outside the options", { ...base, color: "green" }, "color"],
        ["a multi-select over its max", { ...base, tags: ["a", "b", "c"] }, "tags"],
        ["a multi-select under its min", { ...base, tags: [] }, "tags"],
        ["a multi-select option outside the options", { ...base, tags: ["zzz"] }, "tags"],
        ["a non-boolean boolean", { ...base, flag: "yes" }, "flag"],
        ["an approval without a verdict", { ...base, go: {} }, "go"],
      ] as const) {
        const response = await ctx.api("POST", `/api/approval-requests/${id}/respond`, {
          body: { responses },
        });
        expectStatus(response, [400], `respond with ${label}`);
        expect(String(asRecord(response.json).error).includes(needle), `${label} names ${needle}`);
      }
      expect(
        (await ctx.api("GET", `/api/approval-requests/${id}`)).json !== null &&
          asRecord(
            asRecord((await ctx.api("GET", `/api/approval-requests/${id}`)).json).approvalRequest,
          ).status === "pending",
        "refused answers leave the request pending",
      );

      const answered = await respondApproval(ctx, id, {
        go: { approved: true, comment: "ship it" },
        why: `because ${marker}`,
        color: "blue",
        tags: ["a", "c"],
        flag: false,
      });
      const resolved = asRecord(answered.approvalRequest);
      expect(
        resolved.status === "approved" &&
          resolved.resolvedBy === "operator" &&
          typeof resolved.resolvedAt === "string" &&
          resolved.approvalProgress === null,
        `approved by the operator: ${JSON.stringify(resolved)}`,
      );
      const resolvedAnswers = asRecord(resolved.responses);
      expect(
        asRecord(resolvedAnswers.go).comment === "ship it" &&
          resolvedAnswers.color === "blue" &&
          resolvedAnswers.flag === false &&
          (resolvedAnswers.tags as string[]).join(",") === "a,c",
        "the answers are stored by question id",
      );
      const vote = asRecords(resolved, "approvals")[0];
      expect(
        vote?.responder === "operator" &&
          vote.approved === true &&
          vote.claimedRespondedBy === "e2e-operator",
        "the vote keeps the credential's responder and the unverified claimed name",
      );
      const twice = await ctx.api("POST", `/api/approval-requests/${id}/respond`, {
        body: { responses: { go: { approved: true } } },
      });
      expectStatus(twice, [409], "answer a resolved request");
      expect(
        String(asRecord(twice.json).error).includes("already resolved"),
        "409 explains itself",
      );
      expectStatus(
        await ctx.api("POST", `/api/approval-requests/${crypto.randomUUID()}/respond`, {
          body: { responses: { go: { approved: true } } },
        }),
        [404],
        "answer an unknown request",
      );

      // A rejection resolves at once, whatever the policy.
      const rejectMe = await createRequest(ctx, request({ approvers: { policy: { min: 3 } } }));
      const rejected = asRecord(
        (await respondApproval(ctx, String(rejectMe.id), { go: { approved: false } }))
          .approvalRequest,
      );
      expect(rejected.status === "rejected", "one rejection resolves a min-3 request");

      // ── people: user tokens, listed approvers, quorum ───────────────────────
      const inviteUser = async (role: "requester" | "admin") => {
        const email = `appr-${role}-${ctx.nonce}@example.com`;
        const invite = await ctx.api("POST", "/api/invites", { body: { email, role } });
        expectStatus(invite, [201], `invite a ${role}`);
        const code = new URL(String(asRecord(invite.json).inviteUrl)).pathname.split("/")[2];
        const exchange = await ctx.api("POST", "/api/invites/exchange", {
          apiKey: null,
          body: { code },
        });
        expectStatus(exchange, [200], `exchange the ${role} invite`);
        return {
          token: asString(asRecord(exchange.json).token, "user token"),
          userId: asString(asRecord(exchange.json).userId, "user id"),
        };
      };
      const { token, userId } = await inviteUser("admin");
      const requester = await inviteUser("requester");
      const requesterTry = await createRequest(ctx, request());
      const requesterAnswer = await ctx.api(
        "POST",
        `/api/approval-requests/${String(requesterTry.id)}/respond`,
        { apiKey: requester.token, body: { responses: { go: { approved: true } } } },
      );
      expectStatus(requesterAnswer, [403], "a requester cannot answer");
      expect(
        String(asRecord(requesterAnswer.json).error).includes("approval.respond"),
        `a requester lacks approval.respond: ${requesterAnswer.text}`,
      );
      expectStatus(
        await ctx.api("POST", `/api/approval-requests/${String(requesterTry.id)}/cancel`, {
          apiKey: requester.token,
          body: {},
        }),
        [403],
        "a requester cannot cancel another's request",
      );
      await ctx.api("POST", `/api/approval-requests/${String(requesterTry.id)}/cancel`, {
        body: {},
      });
      const asUser = async (
        requestId: string,
        responses: Record<string, unknown>,
        status = 200,
      ) => {
        const response = await ctx.api("POST", `/api/approval-requests/${requestId}/respond`, {
          apiKey: token,
          body: { responses },
        });
        expectStatus(response, [status], `user answers ${requestId}`);
        return asRecord(response.json);
      };

      // Listed users: the operator may always answer, an unlisted user may not.
      const listedOther = await createRequest(
        ctx,
        request({ approvers: { users: [`nobody-${ctx.nonce}`], policy: "any" } }),
      );
      const refusedUser = await asUser(String(listedOther.id), { go: { approved: true } }, 403);
      expect(
        String(refusedUser.error).includes("not one of this request's approvers"),
        `an unlisted user is refused: ${JSON.stringify(refusedUser)}`,
      );
      await respondApproval(ctx, String(listedOther.id), { go: { approved: true } });

      // Invited users carry no `role`, so a roles list can only refuse them. The
      // operator is not bound by it.
      const roleNo = await createRequest(
        ctx,
        request({ approvers: { roles: [`no-such-role-${ctx.nonce}`], policy: "any" } }),
      );
      await asUser(String(roleNo.id), { go: { approved: true } }, 403);
      await respondApproval(ctx, String(roleNo.id), { go: { approved: false } });

      // { min: 2 }: two distinct responders. The same responder answers once.
      const quorum = await createRequest(ctx, request({ approvers: { policy: { min: 2 } } }));
      const firstVote = asRecord(
        (await respondApproval(ctx, String(quorum.id), { go: { approved: true } })).approvalRequest,
      );
      expect(
        firstVote.status === "pending" &&
          asRecord(firstVote.approvalProgress).approved === 1 &&
          asRecord(firstVote.approvalProgress).required === 2 &&
          asRecords(firstVote, "approvals").length === 1,
        `one of two approvals keeps the request pending: ${JSON.stringify(firstVote.approvalProgress)}`,
      );
      const repeat = await ctx.api("POST", `/api/approval-requests/${String(quorum.id)}/respond`, {
        body: { responses: { go: { approved: true } } },
      });
      expectStatus(repeat, [409], "the same responder answers twice");
      expect(String(asRecord(repeat.json).error).includes("already answered"), "duplicate answer");
      const secondVote = asRecord(
        (await asUser(String(quorum.id), { go: { approved: true } })).approvalRequest,
      );
      expect(
        secondVote.status === "approved" && asRecords(secondVote, "approvals").length === 2,
        "the second distinct approval resolves the request",
      );

      // "all" with listed users: the operator's answer does not count for a listed user.
      const everyone = await createRequest(
        ctx,
        request({ approvers: { users: [userId], policy: "all" } }),
      );
      const operatorOnly = asRecord(
        (await respondApproval(ctx, String(everyone.id), { go: { approved: true } }))
          .approvalRequest,
      );
      expect(
        operatorOnly.status === "pending" &&
          asRecord(operatorOnly.approvalProgress).approved === 0 &&
          asRecord(operatorOnly.approvalProgress).required === 1,
        `the operator does not stand in for a listed user: ${JSON.stringify(operatorOnly.approvalProgress)}`,
      );
      const listedAnswer = asRecord(
        (await asUser(String(everyone.id), { go: { approved: true } })).approvalRequest,
      );
      expect(listedAnswer.status === "approved", "the listed user completes the policy");

      // ── late answer: the deadline wins ──────────────────────────────────────
      const timed = await createRequest(ctx, request({ timeoutSeconds: 1 }));
      expect(
        typeof timed.expiresAt === "string" && timed.timeoutSeconds === 1,
        "timeout is stored",
      );
      const expired = await pollUntil(
        () => Date.now() > Date.parse(String(timed.expiresAt)) + 200,
        10_000,
        100,
      );
      expect(expired, "the deadline passed");
      const late = await ctx.api("POST", `/api/approval-requests/${String(timed.id)}/respond`, {
        body: { responses: { go: { approved: true } } },
      });
      expectStatus(late, [409], "answer after the deadline");
      expect(String(asRecord(late.json).error).includes("expired"), "late answer says expired");
      const timedOut = asRecord(
        asRecord((await ctx.api("GET", `/api/approval-requests/${String(timed.id)}`)).json)
          .approvalRequest,
      );
      expect(
        timedOut.status === "timeout" && String(timedOut.resolutionReason).includes("Timed out"),
        `a late answer turns the request into timeout: ${JSON.stringify([timedOut.status, timedOut.resolutionReason])}`,
      );
      const cancelTimedOut = await ctx.api(
        "POST",
        `/api/approval-requests/${String(timed.id)}/cancel`,
        {
          body: {},
        },
      );
      expectStatus(cancelTimedOut, [409], "cancel a timed out request");

      // ── cancel: contract ────────────────────────────────────────────────────
      const doomed = await createRequest(ctx, request({ title: `Doomed ${marker}` }));
      expectStatus(
        await ctx.api("POST", `/api/approval-requests/${String(doomed.id)}/cancel`, {
          apiKey: null,
          body: {},
        }),
        [401],
        "cancel without credentials",
      );
      const foreign = await ctx.api("POST", `/api/approval-requests/${String(doomed.id)}/cancel`, {
        agentId: workerId,
        body: {},
      });
      expectStatus(foreign, [403], "a non-lead agent cannot cancel a request it does not own");
      expectStatus(
        await ctx.api("POST", `/api/approval-requests/${String(doomed.id)}/cancel`, {
          body: { reason: "x".repeat(501) },
        }),
        [400],
        "cancel reason over 500 characters",
      );
      const cancelled = await ctx.api(
        "POST",
        `/api/approval-requests/${String(doomed.id)}/cancel`,
        {
          body: { reason: `not needed ${marker}` },
        },
      );
      expectStatus(cancelled, [200], "cancel a pending request");
      const cancelledJson = asRecord(cancelled.json);
      const cancelledRequest = asRecord(cancelledJson.approvalRequest);
      expect(
        cancelledRequest.status === "cancelled" &&
          cancelledRequest.resolutionReason === `not needed ${marker}` &&
          cancelledRequest.resolvedBy === "operator" &&
          cancelledJson.alreadyCancelled === false &&
          cancelledJson.runCancelled === false,
        `cancelled request: ${JSON.stringify(cancelledJson)}`,
      );
      const cancelAgain = asRecord(
        (await ctx.api("POST", `/api/approval-requests/${String(doomed.id)}/cancel`, { body: {} }))
          .json,
      );
      expect(cancelAgain.alreadyCancelled === true, "a second cancel reports alreadyCancelled");
      expectStatus(
        await ctx.api("POST", `/api/approval-requests/${String(doomed.id)}/respond`, {
          body: { responses: { go: { approved: true } } },
        }),
        [409],
        "answer a cancelled request",
      );
      expectStatus(
        await ctx.api("POST", `/api/approval-requests/${id}/cancel`, { body: {} }),
        [409],
        "cancel an approved request",
      );
      expectStatus(
        await ctx.api("POST", `/api/approval-requests/${crypto.randomUUID()}/cancel`, { body: {} }),
        [404],
        "cancel an unknown request",
      );
      const cancelledList = await ctx.api(
        "GET",
        "/api/approval-requests?status=cancelled&limit=500",
      );
      expect(
        asRecords(cancelledList.json, "approvalRequests").some((entry) => entry.id === doomed.id),
        "status filter finds cancelled requests",
      );

      // ── Slack: only a lead agent may attach a Slack notification ─────────────
      // (The card itself is checked on the workflow node below, which needs no lead.)
      const slackBody = request({ notifications: [{ channel: "slack", target: "C0GENERAL0" }] });
      const slackAsOperator = await ctx.api("POST", "/api/approval-requests", { body: slackBody });
      expectStatus(slackAsOperator, [403], "the operator key cannot attach a Slack notification");
      expect(
        String(asRecord(slackAsOperator.json).error).includes("integration.slack.post"),
        "the refusal names the permission",
      );
      expectStatus(
        await ctx.api("POST", "/api/approval-requests", { agentId: workerId, body: slackBody }),
        [403],
        "a non-lead agent cannot attach a Slack notification",
      );

      // ── MCP: request-human-input and cancel-approval-request ────────────────
      // The worker needs a task in progress for the request to attach to.
      const task = await ctx.api("POST", "/api/tasks", {
        body: { task: `ask a human ${marker}`, agentId: workerId, routingReason: "human_pinned" },
      });
      expectStatus(task, [201], "create the worker's task");
      const taskId = asString(asRecord(task.json).id, "task id");
      const working = await pollUntil(
        async () => {
          const row = ctx.db.get<{ status: string }>(
            "SELECT status FROM agent_tasks WHERE id = ?",
            [taskId],
          );
          return row?.status === "in_progress";
        },
        15_000,
        200,
      );
      expect(working, "the worker took its task and has it in progress");

      const asked = await callToolOk(connection, "request-human-input", {
        title: `Question ${marker}`,
        questions: [
          {
            id: "pick",
            type: "single-select",
            label: "Pick one",
            options: [{ value: "x", label: "X" }],
          },
          { id: "note", type: "text", label: "Note", required: false },
        ],
        timeoutSeconds: 3600,
      });
      const askedId = asString(asked.structured.requestId, "tool request id");
      expect(
        String(asked.structured.url).endsWith(`/approval-requests/${askedId}`) &&
          asked.text.includes(askedId),
        "the tool returns the request id and its dashboard URL",
      );
      const askedRow = asRecord(
        asRecord((await ctx.api("GET", `/api/approval-requests/${askedId}`)).json).approvalRequest,
      );
      expect(
        askedRow.sourceTaskId === taskId &&
          askedRow.status === "pending" &&
          askedRow.timeoutSeconds === 3600 &&
          asRecord(askedRow.approvers).policy === "any",
        `the request attaches to the worker's task: ${JSON.stringify(askedRow)}`,
      );
      const detached = await callToolOk(connection, "request-human-input", {
        title: `Detached ${marker}`,
        questions: [{ id: "ok", type: "boolean", label: "OK?" }],
        detached: true,
      });
      const detachedId = asString(detached.structured.requestId, "detached request id");
      expect(
        asRecord(
          asRecord((await ctx.api("GET", `/api/approval-requests/${detachedId}`)).json)
            .approvalRequest,
        ).sourceTaskId === null,
        "a detached request has no source task",
      );
      // The tool documents `required` as "default: true": an empty answer is refused.
      const laxTool = await callToolOk(connection, "request-human-input", {
        title: `Lax ${marker}`,
        questions: [{ id: "ok", type: "approval", label: "OK?" }],
        detached: true,
      });
      const laxToolId = asString(laxTool.structured.requestId, "lax tool request");
      const laxToolRow = asRecord(
        asRecord((await ctx.api("GET", `/api/approval-requests/${laxToolId}`)).json)
          .approvalRequest,
      );
      expect(
        asRecords(laxToolRow, "questions")[0]?.required === true,
        "the tool stores required as true when it is omitted",
      );
      await respondApproval(ctx, laxToolId, {}, 400);
      await callToolErr(connection, "request-human-input", {
        title: "bad",
        questions: [{ id: "k", type: "config" }],
      });
      await callToolErr(
        connection,
        "request-human-input",
        {
          title: "bad",
          questions: [{ id: "k", type: "text" }],
          detached: true,
        },
        "label",
      );

      // Cancel: the owner of the source task may, a stranger may not, a lead would.
      await callToolErr(otherConnection, "cancel-approval-request", { requestId: askedId });
      await callToolErr(connection, "cancel-approval-request", { requestId: detachedId });
      const ownerCancel = await callToolOk(connection, "cancel-approval-request", {
        requestId: askedId,
        reason: "owner changed their mind",
      });
      expect(
        ownerCancel.structured.alreadyCancelled === false &&
          ownerCancel.structured.runCancelled === false &&
          asRecord(ownerCancel.structured.approvalRequest).status === "cancelled",
        "the owner cancels a request on its task",
      );
      const ownerAgain = await callToolOk(connection, "cancel-approval-request", {
        requestId: askedId,
      });
      expect(ownerAgain.structured.alreadyCancelled === true, "cancel is idempotent");
      await callToolErr(
        connection,
        "cancel-approval-request",
        { requestId: crypto.randomUUID() },
        "not found",
      );
      await callToolErr(
        connection,
        "cancel-approval-request",
        { requestId: id },
        "already resolved",
      );

      // Answering a request raised on a task gives that task's agent a follow-up.
      const followUpFor = await callToolOk(connection, "request-human-input", {
        title: `Follow-up ${marker}`,
        questions: [{ id: "ok", type: "boolean", label: "OK?" }],
      });
      const followUpId = asString(followUpFor.structured.requestId, "follow-up request id");
      await respondApproval(ctx, followUpId, { ok: true });
      const followUp = await pollUntil(
        () =>
          ctx.db.query<{ id: string }>(
            "SELECT id FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'hitl-follow-up'",
            [taskId],
          ).length === 1,
        15_000,
        200,
      );
      expect(followUp, "the answer created one hitl-follow-up task under the source task");
      const followUpTask = ctx.db.get<{ id: string; agentId: string }>(
        "SELECT id, agentId FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'hitl-follow-up'",
        [taskId],
      );
      expect(followUpTask?.agentId === workerId, "the follow-up goes to the agent that asked");
      settleTasks = true;
      // The sim saw the follow-up while tasks were held; close it so no task stays open.
      expectStatus(
        await ctx.api("POST", `/api/tasks/${followUpTask?.id}/finish`, {
          agentId: workerId,
          body: { status: "completed", output: "noted" },
        }),
        [200],
        "finish the follow-up task",
      );
      expectStatus(
        await ctx.api("POST", `/api/tasks/${taskId}/finish`, {
          agentId: workerId,
          body: { status: "completed", output: "asked" },
        }),
        [200],
        "finish the worker's task",
      );

      // ── workflow cards ──────────────────────────────────────────────────────
      const questions = [
        {
          id: "color",
          type: "single-select",
          label: "Pick a color",
          options: [
            { value: "red", label: "Red" },
            { value: "blue", label: "Blue" },
          ],
        },
        { id: "agree", type: "boolean", label: "Agree?" },
        { id: "note", type: "text", label: "Note", required: false },
        { id: "ship", type: "approval", label: "Ship it?" },
      ];
      const hitlId = await createWorkflow(
        ctx,
        "appr-dynamic",
        {
          nodes: [
            {
              id: "gen",
              type: "script",
              config: { runtime: "bash", script: `echo '${JSON.stringify({ questions })}'` },
              next: "ask",
            },
            {
              id: "ask",
              type: "human-in-the-loop",
              inputs: { g: "gen.questions" },
              config: {
                title: `Dynamic card ${marker}`,
                questions: "{{g}}",
                approvers: { policy: "any" },
                notifications: [{ channel: "slack", target: "C0GENERAL0" }],
              },
              next: { approved: "yes", rejected: "no", timeout: "no" },
            },
            {
              id: "yes",
              type: "script",
              inputs: { d: "ask" },
              config: {
                runtime: "bash",
                script: "echo picked-$0-$1",
                args: ["{{d.responses.color}}", "{{d.status}}"],
              },
            },
            { id: "no", type: "script", config: { runtime: "bash", script: "echo declined" } },
          ],
        },
        {},
        workerId,
      );
      const approvedRun = await triggerWorkflow(ctx, hitlId, {}, { agentId: workerId });
      const card = await waitForApproval(ctx, approvedRun.runId);
      expect(
        asRecords(card, "questions")
          .map((q) => q.id)
          .join(",") === "color,agree,note,ship",
        "the card holds the upstream questions in order",
      );
      await ctx.slack.waitForMessage(
        (message) =>
          message.channel === "C0GENERAL0" &&
          JSON.stringify(message).includes(`Dynamic card ${marker}`),
        { timeoutMs: 15_000 },
      );
      const partial = await ctx.api("POST", `/api/approval-requests/${String(card.id)}/respond`, {
        body: { responses: { color: "red", ship: { approved: true } } },
      });
      expectStatus(partial, [400], "respond without a required boolean");
      expect(String(asRecord(partial.json).error).includes("agree"), "names the missing boolean");
      await respondApproval(ctx, String(card.id), {
        color: "red",
        agree: true,
        ship: { approved: true },
      });
      const approvedDetail = await waitForRun(
        ctx,
        approvedRun.runId,
        "completed",
        30_000,
        "approved card",
      );
      expect(
        outputOf(approvedDetail, "yes").stdout === "picked-red-approved",
        "answers reach nodes by id",
      );
      expect(stepOf(approvedDetail, "ask").nextPort === "approved", "routed on approved");

      const rejectedRun = await triggerWorkflow(ctx, hitlId, {}, { agentId: workerId });
      const rejectCard = await waitForApproval(ctx, rejectedRun.runId);
      await respondApproval(ctx, String(rejectCard.id), {
        color: "blue",
        agree: false,
        ship: { approved: false, comment: "not yet" },
      });
      const rejectedDetail = await waitForRun(
        ctx,
        rejectedRun.runId,
        "completed",
        30_000,
        "rejected card",
      );
      expect(stepOf(rejectedDetail, "ask").nextPort === "rejected", "routed on rejected");
      expect(outputOf(rejectedDetail, "no").stdout === "declined", "the rejected branch ran");
      expect(
        outputOf(rejectedDetail, "ask").status === "rejected" &&
          (await approvalsForRun(ctx, rejectedRun.runId, "rejected")).length === 1,
        "the request is stored as rejected",
      );

      // A late answer on a workflow card: the request times out and says so.
      const timedFlow = await createWorkflow(
        ctx,
        "appr-timeout",
        {
          nodes: [
            {
              id: "ask",
              type: "human-in-the-loop",
              config: {
                title: `Timed card ${marker}`,
                questions: [GO],
                approvers: { policy: "any" },
                timeout: { seconds: 1, action: "reject" },
              },
              next: { approved: "yes", timeout: "slow" },
            },
            { id: "yes", type: "script", config: { runtime: "bash", script: "echo yes" } },
            { id: "slow", type: "script", config: { runtime: "bash", script: "echo slow" } },
          ],
        },
        {},
        workerId,
      );
      const timedRun = await triggerWorkflow(ctx, timedFlow, {}, { agentId: workerId });
      const timedCard = await waitForApproval(ctx, timedRun.runId);
      expect(
        typeof timedCard.expiresAt === "string" && timedCard.timeoutSeconds === 1,
        "the node timeout becomes the request deadline",
      );
      await pollUntil(
        () => Date.now() > Date.parse(String(timedCard.expiresAt)) + 200,
        10_000,
        100,
      );
      expectStatus(
        await ctx.api("POST", `/api/approval-requests/${String(timedCard.id)}/respond`, {
          body: { responses: { go: { approved: true } } },
        }),
        [409],
        "answer a workflow card after its deadline",
      );
      expect(
        (await approvalsForRun(ctx, timedRun.runId, "timeout")).length === 1,
        "the workflow card is stored as timeout",
      );
      // The late answer stored the card as `timeout` but left the run waiting. A heartbeat sweep
      // routes the run on its `timeout` port (recoverApprovalWaitingRuns). HEARTBEAT_INTERVAL_MS is
      // 90 s, so trigger one on demand. A sweep that overlaps the timer's own tick is skipped by its
      // concurrency guard, so repeat it until the run leaves `waiting`.
      const routed = await pollUntil(
        async () => {
          expectStatus(
            await ctx.api("POST", "/api/heartbeat/sweep"),
            [200],
            "sweep the timed-out card's run",
          );
          return (await getRunDetail(ctx, timedRun.runId)).run.status !== "waiting";
        },
        30_000,
        500,
      );
      expect(routed, "a heartbeat sweep never moved the timed-out card's run off waiting");
      const timedDetail = await waitForRun(ctx, timedRun.runId, "completed", 15_000, "timed card");
      expect(stepOf(timedDetail, "ask").nextPort === "timeout", "the run routed on timeout");
      expect(outputOf(timedDetail, "ask").status === "timeout", "the step output says timeout");
      expect(outputOf(timedDetail, "slow").stdout === "slow", "the timeout branch ran");
      expect(!hasStep(timedDetail, "yes"), "the approved branch did not run");
      expect(
        (await approvalsForRun(ctx, timedRun.runId, "timeout")).length === 1,
        "the sweep leaves one request, still timeout",
      );

      // A run-linked request: the cancel route cancels the run with it.
      const linkFlow = await createWorkflow(
        ctx,
        "appr-link",
        {
          nodes: [
            {
              id: "ask",
              type: "human-in-the-loop",
              config: { title: `Linked ${marker}`, questions: [GO], approvers: { policy: "any" } },
              next: { approved: "after" },
            },
            { id: "after", type: "script", config: { runtime: "bash", script: "echo after" } },
          ],
        },
        {},
        workerId,
      );
      const linkRun = await triggerWorkflow(ctx, linkFlow, {}, { agentId: workerId });
      const linkCard = await waitForApproval(ctx, linkRun.runId);
      const linkCancel = asRecord(
        (
          await ctx.api("POST", `/api/approval-requests/${String(linkCard.id)}/cancel`, {
            body: { reason: "drop the run" },
          })
        ).json,
      );
      expect(linkCancel.runCancelled === true, "cancelling the request reports runCancelled");
      expect(
        (await getRunDetail(ctx, linkRun.runId)).run.status === "cancelled",
        "the workflow run was cancelled with its request",
      );
      const authoring = await ctx.api("POST", "/api/workflows", {
        body: {
          name: `appr-bad-${ctx.nonce}`,
          definition: {
            nodes: [
              {
                id: "ask",
                type: "human-in-the-loop",
                config: {
                  title: "x",
                  questions: "prefix {{g}}",
                  approvers: { policy: "any" },
                },
              },
            ],
          },
        },
      });
      expectStatus(authoring, [400], "questions must be one exact token");

      // A dynamic list that resolves to nothing fails the node and raises no card.
      const emptyFlow = await createWorkflow(
        ctx,
        "appr-empty",
        {
          nodes: [
            {
              id: "gen",
              type: "script",
              config: { runtime: "bash", script: `echo '{"questions":[]}'` },
              next: "ask",
            },
            {
              id: "ask",
              type: "human-in-the-loop",
              inputs: { g: "gen.questions" },
              config: { title: "empty", questions: "{{g}}", approvers: { policy: "any" } },
            },
          ],
        },
        {},
        workerId,
      );
      const emptyRun = await triggerWorkflow(ctx, emptyFlow, {}, { agentId: workerId });
      const emptyDetail = await waitForRun(
        ctx,
        emptyRun.runId,
        "failed",
        20_000,
        "empty questions",
      );
      expect(
        String(stepOf(emptyDetail, "ask").error).includes("empty"),
        `an empty question list fails the node: ${String(stepOf(emptyDetail, "ask").error)}`,
      );
      expect(
        (await approvalsForRun(ctx, emptyRun.runId)).length === 0,
        "no card is raised for an empty question list",
      );
    } finally {
      await sim.stop();
      await connection.close();
      await otherConnection.close();
    }
  },
};
