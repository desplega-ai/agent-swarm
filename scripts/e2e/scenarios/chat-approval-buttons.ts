import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { deleteConfig, putConfig, registerAgent, reloadConfig } from "./platform-helpers";
import {
  createWorkflow,
  registerWorker,
  respondApproval,
  stepOf,
  triggerWorkflow,
  type WorkflowDef,
  waitForApproval,
  waitForRun,
} from "./workflow-helpers";

type Call = { method: string; path: string; body: Record<string, unknown>; id: string };

async function approvalButtons(ctx: ScenarioContext, platform: "discord" | "teams") {
  const origin = asString(
    JSON.parse(ctx.sutEnv.CHAT_SDK_API_URL_OVERRIDES ?? "{}")[platform],
    "mock origin",
  );
  const channelId = "123456789012345678";
  const guildId = "987654321098765432";
  const conversationId = `19:approvals-${ctx.nonce}@thread.v2`;
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  const target =
    platform === "discord"
      ? `discord:${guildId}:${channelId}`
      : `teams:${encode(conversationId)}:${encode(origin)}`;
  const approver = platform === "discord" ? "700000000000000001" : "29:approver";
  const stranger = platform === "discord" ? "700000000000000002" : "29:stranger";
  const appId = "00000000-0000-0000-0000-000000000099";
  const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString(
    "hex",
  );
  const calls: Call[] = [];
  const mock = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(new URL(origin).port),
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = asRecord(await request.json().catch(() => ({})));
      const id = String(5000 + calls.length);
      calls.push({ method: request.method, path, body, id });
      return Response.json({ id, channel_id: channelId, ...body });
    },
  });
  let configId: string | undefined;
  try {
    configId = asString(
      (
        await putConfig(ctx, {
          key: "CHAT_SDK_ADAPTERS",
          value: JSON.stringify({
            [platform]:
              platform === "discord"
                ? { botToken: "discord-e2e-token", applicationId: channelId, publicKey }
                : { appId, appPassword: "teams-e2e-password" },
          }),
        })
      ).id,
      "adapter config id",
    );
    await reloadConfig(ctx);
    const created = await ctx.api("POST", "/api/users", {
      body: {
        name: `${platform} Approver ${ctx.nonce}`,
        email: `${platform}-approver-${ctx.nonce}@example.com`,
        identities: [{ kind: platform, externalId: approver }],
      },
    });
    expectStatus(created, [200, 201], "create linked approver");
    const userId = asString(asRecord(asRecord(created.json).user).id, "approver id");
    const leadId = await registerAgent(ctx, `${platform}-approval-lead`, { lead: true });
    const workerId = await registerWorker(ctx, `${platform}-approval-worker`);
    const questions = [{ id: "ship", type: "approval", label: "Ship it?" }];
    const notification = { channel: platform, target };
    const workflow = (title: string): WorkflowDef => ({
      nodes: [
        {
          id: "ask",
          type: "human-in-the-loop",
          config: {
            title,
            questions,
            approvers: { policy: "any" },
            notifications: [notification],
          },
          next: { approved: "yes", rejected: "no", timeout: "no" },
        },
        { id: "yes", type: "script", config: { runtime: "bash", script: "echo yes" } },
        { id: "no", type: "script", config: { runtime: "bash", script: "echo no" } },
      ],
    });
    const getApproval = async (id: string) => {
      const response = await ctx.api("GET", `/api/approval-requests/${id}`);
      expectStatus(response, [200], "read approval");
      return asRecord(asRecord(response.json).approvalRequest);
    };
    const cardFor = async (title: string) => {
      let card: Call | undefined;
      expect(
        await pollUntil(() => {
          card = calls.find((c) => c.method === "POST" && JSON.stringify(c.body).includes(title));
          return Boolean(card);
        }, 15_000),
        `${platform} posted ${title}: ${JSON.stringify(calls).slice(-1500)}`,
      );
      return card!;
    };
    const edited = async (id: string, outcome: string) => {
      expect(
        await pollUntil(
          () =>
            calls.some(
              (c) =>
                c.method === (platform === "discord" ? "PATCH" : "PUT") &&
                c.path.endsWith(`/${id}`) &&
                JSON.stringify(c.body).includes(outcome) &&
                !JSON.stringify(c.body).includes("ha:"),
            ),
          15_000,
        ),
        `${platform} edits ${id} to ${outcome} without answer buttons`,
      );
    };
    const click = async (card: Call, requestId: string, user: string, choice: string) => {
      const body =
        platform === "discord"
          ? {
              type: 3,
              id: crypto.randomUUID(),
              application_id: channelId,
              token: "interaction-token",
              channel_id: channelId,
              guild_id: guildId,
              member: { user: { id: user, username: "Clicker" } },
              message: { id: card.id },
              data: { component_type: 2, custom_id: `ha:${choice}\n${requestId}` },
            }
          : {
              type: "message",
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              channelId: "msteams",
              serviceUrl: origin,
              from: { id: user, name: "Clicker" },
              recipient: { id: `28:${appId}`, name: "swarm" },
              conversation: { id: conversationId, conversationType: "groupChat", isGroup: true },
              replyToId: card.id,
              value: { actionId: `ha:${choice}`, value: requestId },
            };
      const rawBody = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers: Record<string, string> =
        platform === "discord"
          ? {
              "x-signature-timestamp": timestamp,
              "x-signature-ed25519": Buffer.from(
                await crypto.subtle.sign(
                  "Ed25519",
                  keys.privateKey,
                  new TextEncoder().encode(timestamp + rawBody),
                ),
              ).toString("hex"),
            }
          : { authorization: `Bearer ${ctx.sutEnv.CHAT_SDK_E2E_WEBHOOK_TOKEN}` };
      const response = await ctx.api("POST", `/api/integrations/chat/${platform}/webhook`, {
        apiKey: null,
        rawBody,
        headers: { ...headers, "content-type": "application/json" },
      });
      expectStatus(response, [200], `${platform} button callback`);
    };

    // Both authoring entry points must gate the newly admitted transports.
    expectStatus(
      await ctx.api("POST", "/api/approval-requests", {
        agentId: workerId,
        body: {
          title: "forbidden",
          approvers: { policy: "any" },
          questions,
          notifications: [notification],
        },
      }),
      [403],
      "worker cannot create a chat notification over REST",
    );
    const forbiddenTitle = `${platform} forbidden ${ctx.nonce}`;
    const forbiddenId = await createWorkflow(
      ctx,
      `${platform}-forbidden`,
      workflow(forbiddenTitle),
      {},
      workerId,
    );
    const forbiddenRun = await triggerWorkflow(ctx, forbiddenId, {}, { agentId: workerId });
    const failed = await waitForRun(
      ctx,
      forbiddenRun.runId,
      "failed",
      30_000,
      "unauthorized author",
    );
    expect(
      JSON.stringify(stepOf(failed, "ask")).includes("integration.chat.post"),
      "workflow enforces post grant",
    );
    expect(
      !calls.some((c) => JSON.stringify(c.body).includes(forbiddenTitle)),
      "unauthorized workflow posts no card",
    );

    for (const choice of ["y", "n"]) {
      const title = `${platform} ${choice} ${ctx.nonce}`;
      const workflowId = await createWorkflow(
        ctx,
        `${platform}-${choice}`,
        workflow(title),
        {},
        leadId,
      );
      const run = await triggerWorkflow(ctx, workflowId, {}, { agentId: leadId });
      const approval = await waitForApproval(ctx, run.runId);
      const id = String(approval.id);
      const card = await cardFor(title);
      const raw = JSON.stringify(card.body);
      expect(
        raw.includes("ha:y") &&
          raw.includes("ha:n") &&
          raw.includes("Open in UI") &&
          raw.includes(`/approval-requests/${id}`),
        "card contains both answers and dashboard link",
      );
      expect(
        await pollUntil(
          async () =>
            asRecords(await getApproval(id), "notificationChannels").some(
              (n) => n.messageId === card.id && n.threadId === target,
            ),
          5000,
        ),
        "card address persisted",
      );
      if (choice === "y") {
        await click(card, id, stranger, "y");
        expect(
          await pollUntil(async () => {
            const result = await ctx.api(
              "GET",
              `/api/kv/_/${encodeURIComponent(`integration:unmapped:${platform}`)}/${encodeURIComponent(`${stranger}:meta`)}`,
            );
            return result.status === 200;
          }, 10_000),
          "unlinked click was processed",
        );
        expect((await getApproval(id)).status === "pending", "unlinked click does not resolve");
      }
      await click(card, id, approver, choice);
      const done = await waitForRun(ctx, run.runId, "completed", 30_000, `${platform} answer`);
      expect(
        stepOf(done, "ask").nextPort === (choice === "y" ? "approved" : "rejected"),
        "click routes the workflow",
      );
      const row = await getApproval(id);
      const vote = asRecords(row, "approvals")[0] ?? {};
      expect(
        row.resolvedBy === userId &&
          asRecord(vote.via).channel === platform &&
          asRecord(vote.via).platformUserId === approver,
        "vote records mapped user and platform identity",
      );
      await edited(card.id, choice === "y" ? "Approved" : "Rejected");
      const beforeLateClick = calls.length;
      await click(card, id, approver, choice === "y" ? "n" : "y");
      expect(
        await pollUntil(
          () =>
            calls
              .slice(beforeLateClick)
              .some((call) => JSON.stringify(call.body).includes(`already ${row.status}`)),
          10_000,
        ),
        "late click was processed",
      );
      expect((await getApproval(id)).status === row.status, "late click cannot reverse decision");
    }

    // REST/dashboard resolution also updates cards, including requests with text inputs.
    const title = `${platform} dashboard ${ctx.nonce}`;
    const form = await ctx.api("POST", "/api/approval-requests", {
      agentId: leadId,
      body: {
        title,
        questions: [{ id: "note", type: "text", label: "Release note", required: true }],
        approvers: { policy: "any" },
        notifications: [notification],
      },
    });
    expectStatus(form, [201], "create dashboard request");
    const formId = asString(asRecord(asRecord(form.json).approvalRequest).id, "approval id");
    const formCard = await cardFor(title);
    expect(!JSON.stringify(formCard.body).includes("ha:"), "text input keeps dashboard link only");
    await respondApproval(ctx, formId, { note: "Ship today" });
    await edited(formCard.id, "Approved");
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
}

export const discordApprovalButtons: Scenario = {
  name: "discord-approval-buttons",
  order: 651.6,
  run: (ctx) => approvalButtons(ctx, "discord"),
};
export const teamsApprovalButtons: Scenario = {
  name: "teams-approval-buttons",
  order: 651.7,
  run: (ctx) => approvalButtons(ctx, "teams"),
};
