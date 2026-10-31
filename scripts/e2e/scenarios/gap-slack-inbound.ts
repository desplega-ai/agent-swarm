import { drainTasks } from "../gap-helpers";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { claim, findSlackTask, finish, registerLead } from "./slack-helpers";

// #2561: inbound Slack messages keep table blocks and the files of a shared message.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 4, 2, 4, 2]);
const cell = (text: string) => ({ type: "raw_text", text });

async function waitPromoted(ctx: ScenarioContext, taskId: string): Promise<void> {
  const ok = await pollUntil(async () => {
    const r = await ctx.api("GET", `/api/tasks/${taskId}`);
    return asRecord(r.json).status !== "draft";
  }, 20_000);
  expect(ok, `task ${taskId} stayed draft`);
}

async function attachments(
  ctx: ScenarioContext,
  taskId: string,
): Promise<Record<string, unknown>[]> {
  const list = await ctx.api("GET", `/api/fs/tasks/${taskId}/files`);
  expectStatus(list, [200], `list attachments of ${taskId}`);
  const a = asRecord(list.json).attachments;
  return Array.isArray(a) ? a.map(asRecord) : [];
}

export const gapSlackInbound: Scenario = {
  name: "gap-slack-inbound",
  order: 1130,
  async run(ctx) {
    try {
      await gapRun(ctx);
    } finally {
      await drainTasks(ctx);
    }
  },
};

async function gapRun(ctx: ScenarioContext): Promise<void> {
  await registerLead(ctx, "e2e-lead-gap-inbound");
  const bot = ctx.slack.bot.userId;
  // Own user: the Slack handler rate-limits each user to 10 mentions a minute, and the other gap
  // scenarios post as alice just before this one.
  const poster = ctx.slack.addUser({ name: `gapinbound${ctx.nonce}` });
  const mention = `<@${bot}>`;
  const richText = (t: string) => ({
    type: "rich_text",
    elements: [
      {
        type: "rich_text_section",
        elements: [
          { type: "user", user_id: bot },
          { type: "text", text: t },
        ],
      },
    ],
  });

  // --- table block ---
  const withTable = await ctx.slack.postMessage({
    channel: "general",
    user: poster.id,
    text: `${mention} summarise the sales`,
    blocks: [
      richText(" summarise the sales"),
      {
        type: "table",
        rows: [
          [cell("Region"), cell("Units")],
          [cell("EMEA"), cell("1234")],
          [cell("APAC"), cell("567")],
        ],
      },
    ],
  });
  const tTask = await findSlackTask(ctx, withTable.ts);
  const tText = String(tTask.task);
  expect(
    tText.includes("| Region | Units |") &&
      tText.includes("| EMEA | 1234 |") &&
      tText.includes("| APAC | 567 |"),
    `table rows missing from task text: ${JSON.stringify(tText)}`,
  );
  expect(tText.indexOf("Region") < tText.indexOf("EMEA"), "header row not first");
  // Negative control: same sentence without a table block carries no table.
  const noTable = await ctx.slack.postMessage({
    channel: "general",
    user: poster.id,
    text: `${mention} summarise the sales`,
    blocks: [richText(" summarise the sales")],
  });
  const nTask = await findSlackTask(ctx, noTable.ts);
  expect(
    !String(nTask.task).includes("|") && !String(nTask.task).includes("EMEA"),
    `control task text has table residue: ${JSON.stringify(nTask.task)}`,
  );

  // --- shared-message files ---
  const shared = await ctx.slack.postMessage({
    channel: "general",
    user: poster.id,
    text: `${mention} look at this forwarded image`,
    attachments: [
      {
        is_share: true,
        is_msg_unfurl: true,
        text: "original message",
        from_url: "https://example.slack.com/archives/C1/p1",
        files: [{ name: "forwarded.png", content: PNG, mimetype: "image/png" }],
      },
    ],
  });
  expect(!shared.files?.length, "premise: shared message must have empty top-level files");
  const sTask = await findSlackTask(ctx, shared.ts);
  await waitPromoted(ctx, String(sTask.id));
  const sAtt = await attachments(ctx, String(sTask.id));
  expect(
    sAtt.length === 1 && sAtt[0].name === "forwarded.png",
    `shared-message attachments: ${JSON.stringify(sAtt.map((a) => a.name))}`,
  );
  expect(
    String(sTask.task).includes("[File: forwarded.png"),
    `task text lacks the file marker: ${JSON.stringify(sTask.task)}`,
  );
  const raw = await fetch(`${ctx.baseUrl}/api/fs/tasks/${sTask.id}/files/${sAtt[0].id}/raw`, {
    headers: { Authorization: `Bearer ${ctx.apiKey}` },
  });
  const bytes = new Uint8Array(await raw.arrayBuffer());
  expect(
    raw.ok && bytes.length === PNG.length && bytes.every((b, i) => b === PNG[i]),
    "stored bytes differ from the shared file",
  );

  // Negative control: attachment without files -> no task attachments.
  const plain = await ctx.slack.postMessage({
    channel: "general",
    user: poster.id,
    text: `${mention} look at this link`,
    attachments: [{ is_share: true, text: "original message, no file" }],
  });
  const pTask = await findSlackTask(ctx, plain.ts);
  await waitPromoted(ctx, String(pTask.id));
  expect(
    (await attachments(ctx, String(pTask.id))).length === 0,
    "control: attachment without files produced a task attachment",
  );

  // Distinct bytes on top-level and shared files: both are kept (identical bytes dedupe by sha256).
  const both = await ctx.slack.postMessage({
    channel: "general",
    user: poster.id,
    text: `${mention} two files`,
    files: [{ name: "top.png", content: PNG, mimetype: "image/png" }],
    attachments: [
      {
        is_share: true,
        text: "fwd",
        files: [{ name: "fwd.png", content: new Uint8Array([...PNG, 9]), mimetype: "image/png" }],
      },
    ],
  });
  const bTask = await findSlackTask(ctx, both.ts);
  await waitPromoted(ctx, String(bTask.id));
  const names = (await attachments(ctx, String(bTask.id))).map((a) => a.name).sort();
  expect(
    JSON.stringify(names) === JSON.stringify(["fwd.png", "top.png"]),
    `top-level + shared files: ${JSON.stringify(names)}`,
  );

  // --- slack-read renders the table ---
  const mcp = await ctx.connectMcp(String(tTask.agentId));
  try {
    await claim(ctx, String(tTask.agentId), String(tTask.id));
    const res = await mcp.callTool("slack-read", { taskId: String(tTask.id) });
    expect(!res.isError, `slack-read failed: ${JSON.stringify(res).slice(0, 300)}`);
    const out = JSON.stringify(res);
    ctx.log(`slack-read mentions table: ${out.includes("EMEA")}`);
  } finally {
    await mcp.close();
  }
  // Leave nothing pending.
  for (const t of [tTask, nTask, sTask, pTask, bTask]) {
    const cur = asRecord((await ctx.api("GET", `/api/tasks/${t.id}`)).json).status;
    if (cur === "pending") await claim(ctx, String(t.agentId), String(t.id)).catch(() => {});
    const now = asRecord((await ctx.api("GET", `/api/tasks/${t.id}`)).json).status;
    if (now === "in_progress")
      await finish(ctx, String(t.agentId), String(t.id), {
        status: "completed",
        output: "done",
      }).catch(() => {});
  }
}
