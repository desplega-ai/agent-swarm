import { drainTasks } from "../gap-helpers";
import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { ask, claim, findSlackTask, registerLead, waitForEyes } from "./slack-helpers";

// #2551: per-agent Slack icon. slackIcon -> icon_emoji / icon_url / none on persona posts.
type PersonaMsg = { username?: string; icon_emoji?: string; icon_url?: string; text?: string };

export const gapSlackIcon: Scenario = {
  name: "gap-slack-icon",
  order: 1120,
  async run(ctx) {
    try {
      await gapRun(ctx);
    } finally {
      await drainTasks(ctx);
    }
  },
};

async function gapRun(ctx: ScenarioContext): Promise<void> {
  // The endpoint caches its first answer, so the mock reports an app avatar (bots.info icons.image_72) before any call.
  const store = (ctx.slack as unknown as { store: { appIconUrl?: string } }).store;
  store.appIconUrl = "https://example.com/app-avatar.png";
  let leadId = await registerLead(ctx, "e2e-lead-gap-icon");
  const root = await ask(ctx, "icon test");
  await waitForEyes(ctx, root.ts);
  const task = await findSlackTask(ctx, root.ts);
  leadId = String(task.agentId);
  const taskId = String(task.id);
  await claim(ctx, leadId, taskId);
  const mcp = await ctx.connectMcp(leadId);

  const setIcon = async (slackIcon: unknown, expectStatusCode = 200) => {
    const r = await ctx.api("PUT", `/api/agents/${leadId}/profile`, { body: { slackIcon } });
    expectStatus(r, [expectStatusCode], `PUT slackIcon ${JSON.stringify(slackIcon)}`);
    return r;
  };
  let n = 0;
  const post = async (): Promise<PersonaMsg> => {
    const text = `icon probe ${ctx.nonce} ${++n}`;
    const res = await mcp.callTool("slack-reply", { taskId, message: text });
    expect(!res.isError, `slack-reply failed: ${JSON.stringify(res).slice(0, 300)}`);
    const call = ctx.slack
      .apiCalls("chat.postMessage")
      .reverse()
      .find((c) => JSON.stringify(c.args).includes(text));
    expect(call, `SUT never sent chat.postMessage with "${text}"`);
    // What the SUT sent, so an omitted key is observable.
    return call.args as unknown as PersonaMsg;
  };

  try {
    // 1. Default (null): lead keeps :crown:, no icon_url.
    const base = await post();
    expect(
      base.icon_emoji === ":crown:" && !base.icon_url,
      `default icon: ${JSON.stringify([base.icon_emoji, base.icon_url])}`,
    );
    expect(!!base.username, "persona post carried no username");

    // 2. Emoji.
    await setIcon({ type: "emoji", emoji: ":owl:" });
    const e = await post();
    expect(
      e.icon_emoji === ":owl:" && !e.icon_url,
      `emoji icon: ${JSON.stringify([e.icon_emoji, e.icon_url])}`,
    );
    const prof = asRecord((await ctx.api("GET", `/api/agents/${leadId}`)).json);
    expect(
      JSON.stringify(prof.slackIcon) === JSON.stringify({ type: "emoji", emoji: ":owl:" }),
      `stored slackIcon ${JSON.stringify(prof.slackIcon)}`,
    );

    // 3. Omitting the key leaves it unchanged.
    expectStatus(
      await ctx.api("PUT", `/api/agents/${leadId}/profile`, {
        body: { description: "icon e2e lead" },
      }),
      [200],
      "PUT description only",
    );
    const kept = await post();
    expect(kept.icon_emoji === ":owl:", `omitted slackIcon changed icon to ${kept.icon_emoji}`);

    // 4. URL.
    await setIcon({ type: "url", url: "https://example.com/avatar.png" });
    const u = await post();
    expect(
      u.icon_url === "https://example.com/avatar.png" && !u.icon_emoji,
      `url icon: ${JSON.stringify([u.icon_emoji, u.icon_url])}`,
    );

    // 5. App avatar: no override key at all.
    await setIcon({ type: "app" });
    const a = await post();
    expect(
      !a.icon_emoji && !a.icon_url,
      `app icon still sent ${JSON.stringify([a.icon_emoji, a.icon_url])}`,
    );

    // 6. Validation rejects (and leaves the stored value alone).
    for (const bad of [
      { type: "url", url: "http://example.com/a.png" },
      { type: "url", url: "https://user:pw@example.com/a.png" },
      { type: "emoji", emoji: "owl" },
      { type: "emoji", emoji: ":OWL:" },
      { type: "other" },
    ]) {
      const r = await ctx.api("PUT", `/api/agents/${leadId}/profile`, { body: { slackIcon: bad } });
      expect(
        r.status === 400 || r.status === 422,
        `invalid ${JSON.stringify(bad)} accepted: ${r.status}`,
      );
    }
    const still = await post();
    expect(!still.icon_emoji && !still.icon_url, "rejected update altered the stored icon");

    // 7. null resets to the default.
    await setIcon(null);
    const reset = await post();
    expect(reset.icon_emoji === ":crown:", `reset icon: ${reset.icon_emoji}`);

    // 8. Agent can set its own icon via the MCP update-profile tool.
    const up = await mcp.callTool("update-profile", {
      slackIcon: { type: "emoji", emoji: ":rocket:" },
    });
    expect(!up.isError, `update-profile slackIcon failed: ${JSON.stringify(up).slice(0, 300)}`);
    const viaTool = await post();
    expect(viaTool.icon_emoji === ":rocket:", `update-profile icon: ${viaTool.icon_emoji}`);

    // 9. Dashboard preview endpoint answers with the contract shape.
    const ai = await ctx.api("GET", "/api/integrations/slack/app-icon");
    expectStatus(ai, [200], "app-icon");
    const body = asRecord(ai.json);
    expect(
      "imageUrl" in body && (body.imageUrl === null || typeof body.imageUrl === "string"),
      `app-icon body ${ai.text}`,
    );
    expect(body.imageUrl === "https://example.com/app-avatar.png", `app-icon relayed ${ai.text}`);
  } finally {
    await mcp.close();
  }
}
