import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { deleteConfig, putConfig, registerAgent, reloadConfig } from "./platform-helpers";
import {
  createWorkflow,
  registerWorker,
  stepOf,
  triggerWorkflow,
  type WorkflowDef,
  waitForApproval,
  waitForRun,
} from "./workflow-helpers";

type Call = { method: string; body: Record<string, unknown> };

async function getApproval(ctx: ScenarioContext, id: string): Promise<Record<string, unknown>> {
  const response = await ctx.api("GET", `/api/approval-requests/${id}`);
  expectStatus(response, [200], `read approval ${id}`);
  return asRecord(asRecord(response.json).approvalRequest);
}

/**
 * Inline approval buttons on Telegram: the HITL card goes out with an inline
 * keyboard, an unlinked clicker changes nothing, a linked approver resolves the
 * run with one click, and the card is edited to the outcome with its keyboard
 * removed. A late click leaves the decision as it was. A workflow written by a
 * non-lead agent may not post a Telegram card: its step fails and the bot sends
 * nothing.
 */
export const telegramApprovalButtons: Scenario = {
  name: "telegram-approval-buttons",
  // After platform-chat-sdk (651), which stops its own mock on the same port.
  order: 651.5,
  async run(ctx) {
    const chatId = `-${Number.parseInt(ctx.nonce.slice(0, 8), 16)}`;
    const approverTelegramId = String(7_000_000 + Number.parseInt(ctx.nonce.slice(0, 4), 16));
    const strangerTelegramId = String(Number(approverTelegramId) + 1);
    const secretToken = `telegram-webhook-${crypto.randomUUID()}`;
    const origin = asString(
      asRecord(JSON.parse(ctx.sutEnv.CHAT_SDK_API_URL_OVERRIDES ?? "{}")).telegram,
      "Telegram mock origin",
    );
    const calls: Call[] = [];
    let nextMessageId = 5000;
    const bot = { id: 4243, is_bot: true, first_name: "Swarm", username: "swarm_e2e_bot" };
    const mock = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(new URL(origin).port),
      async fetch(request) {
        const method = new URL(request.url).pathname.split("/").at(-1) ?? "";
        const body = asRecord(await request.json().catch(() => ({})));
        calls.push({ method, body });
        if (method === "getMe") return Response.json({ ok: true, result: bot });
        if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: "" } });
        if (method === "sendMessage" || method === "editMessageText") {
          return Response.json({
            ok: true,
            result: {
              message_id: method === "sendMessage" ? ++nextMessageId : body.message_id,
              date: Math.floor(Date.now() / 1000),
              chat: { id: body.chat_id, type: "group" },
              from: bot,
              text: body.text,
            },
          });
        }
        return Response.json({ ok: true, result: true });
      },
    });
    const created = await ctx.api("POST", "/api/users", {
      body: {
        name: `Telegram Approver ${ctx.nonce}`,
        email: `tg-approver-${ctx.nonce}@example.com`,
        identities: [{ kind: "telegram", externalId: approverTelegramId }],
      },
    });
    expectStatus(created, [200, 201], "create the linked approver");
    const approverUserId = asString(asRecord(asRecord(created.json).user).id, "approver id");

    let configId: string | undefined;
    try {
      configId = asString(
        (
          await putConfig(ctx, {
            key: "CHAT_SDK_ADAPTERS",
            value: JSON.stringify({
              telegram: {
                botToken: `telegram-bot-${crypto.randomUUID()}`,
                secretToken,
                mode: "webhook",
              },
            }),
          })
        ).id,
        "adapter config id",
      );
      await reloadConfig(ctx);

      const approvalWorkflow = (title: string): WorkflowDef => ({
        nodes: [
          {
            id: "ask",
            type: "human-in-the-loop",
            config: {
              title,
              questions: [{ id: "ship", type: "approval", label: "Ship it?" }],
              approvers: { policy: "any" },
              notifications: [{ channel: "telegram", target: chatId }],
            },
            next: { approved: "yes", rejected: "no", timeout: "no" },
          },
          { id: "yes", type: "script", config: { runtime: "bash", script: "echo yes" } },
          { id: "no", type: "script", config: { runtime: "bash", script: "echo no" } },
        ],
      });

      // A non-lead writer: the step fails before any approval or Telegram send.
      const deniedTitle = `Telegram denied ${ctx.nonce}`;
      const workerId = await registerWorker(ctx, "tg-appr");
      const deniedWorkflowId = await createWorkflow(
        ctx,
        "tg-denied",
        approvalWorkflow(deniedTitle),
        {},
        workerId,
      );
      const deniedRun = await triggerWorkflow(ctx, deniedWorkflowId, {}, { agentId: workerId });
      const failed = await waitForRun(ctx, deniedRun.runId, "failed", 30_000, "Telegram denied");
      expect(
        /integration\.chat\.post/.test(JSON.stringify(stepOf(failed, "ask"))),
        `the step names the missing verb: ${JSON.stringify(stepOf(failed, "ask")).slice(0, 1500)}`,
      );
      expect(
        !calls.some(
          (c) => c.method === "sendMessage" && JSON.stringify(c.body).includes(deniedTitle),
        ),
        "a non-lead workflow sends no Telegram card",
      );

      const title = `Telegram approve ${ctx.nonce}`;
      const leadId = await registerAgent(ctx, "tg-appr-lead", { lead: true });
      const workflowId = await createWorkflow(
        ctx,
        "tg-approve",
        approvalWorkflow(title),
        {},
        leadId,
      );
      const run = await triggerWorkflow(ctx, workflowId, {}, { agentId: leadId });
      const approval = await waitForApproval(ctx, run.runId);
      const approvalId = String(approval.id);

      let card: Call | undefined;
      const posted = await pollUntil(() => {
        card = calls.find(
          (c) => c.method === "sendMessage" && JSON.stringify(c.body).includes(title),
        );
        return card !== undefined;
      }, 15_000);
      expect(
        posted && card,
        `no Telegram card for ${title}: ${JSON.stringify(calls).slice(0, 1500)}`,
      );
      const keyboard = JSON.stringify(asRecord(card.body).reply_markup ?? {});
      expect(
        keyboard.includes("ha:y") &&
          keyboard.includes("ha:n") &&
          keyboard.includes(`/approval-requests/${approvalId}`),
        `the card has Approve, Deny and the dashboard link: ${keyboard.slice(0, 1500)}`,
      );
      const stored = asRecords(await getApproval(ctx, approvalId), "notificationChannels")[0] ?? {};
      const messageId = asString(stored.messageId, "stored Telegram message id");
      const messageNumber = Number(messageId.split(":").at(-1));

      let updateId = Number.parseInt(ctx.nonce.slice(0, 6), 16);
      const click = async (fromId: string, choice: string) => {
        const response = await ctx.api("POST", "/api/integrations/chat/telegram/webhook", {
          headers: { "X-Telegram-Bot-Api-Secret-Token": secretToken },
          body: {
            update_id: ++updateId,
            callback_query: {
              id: `cq-${updateId}`,
              from: { id: Number(fromId), is_bot: false, first_name: "Clicker" },
              chat_instance: "e2e",
              message: {
                message_id: messageNumber,
                date: Math.floor(Date.now() / 1000),
                chat: { id: Number(chatId), type: "group" },
                text: title,
              },
              data: `chat:${JSON.stringify({ a: `ha:${choice}`, v: approvalId })}`,
            },
          },
        });
        expectStatus(response, [200], `Telegram callback from ${fromId}`);
      };

      await click(strangerTelegramId, "y");
      const answered = await pollUntil(
        () => calls.some((c) => c.method === "answerCallbackQuery"),
        15_000,
      );
      expect(answered, "the callback query is answered");
      // The stranger's refusal is sent before the approver clicks: nothing may have changed.
      await pollUntil(
        () =>
          calls.some(
            (c) => c.method === "sendMessage" && String(c.body.chat_id) === strangerTelegramId,
          ),
        5_000,
      );
      expect(
        (await getApproval(ctx, approvalId)).status === "pending",
        "an unlinked click changes nothing",
      );

      await click(approverTelegramId, "y");
      const done = await waitForRun(ctx, run.runId, "completed", 30_000, "Telegram approve");
      expect(stepOf(done, "ask").nextPort === "approved", "the click routed on approved");
      const row = await getApproval(ctx, approvalId);
      const vote = asRecords(row, "approvals")[0] ?? {};
      expect(
        row.resolvedBy === approverUserId &&
          asRecord(vote.via).channel === "telegram" &&
          asRecord(vote.via).platformUserId === approverTelegramId,
        `the vote records the mapped user and the Telegram clicker: ${JSON.stringify(row)}`,
      );
      const edited = await pollUntil(
        () =>
          calls.some(
            (c) =>
              c.method === "editMessageText" &&
              Number(c.body.message_id) === messageNumber &&
              /Approved/.test(JSON.stringify(c.body)) &&
              !JSON.stringify(c.body).includes("ha:"),
          ),
        15_000,
      );
      expect(
        edited,
        `the card is edited to the outcome without buttons: ${JSON.stringify(
          calls.filter((c) => c.method === "editMessageText"),
        ).slice(0, 1500)}`,
      );

      const answers = () => calls.filter((c) => c.method === "answerCallbackQuery").length;
      const before = answers();
      await click(approverTelegramId, "n");
      expect(await pollUntil(() => answers() > before, 15_000), "the late click is answered");
      expect(
        (await getApproval(ctx, approvalId)).status === "approved",
        "a late Deny does not flip an approved request",
      );
    } finally {
      try {
        if (configId) {
          await deleteConfig(ctx, configId);
          await reloadConfig(ctx);
        }
      } finally {
        mock.stop(true);
      }
    }
  },
};
