import { expect } from "../http";
import type { Scenario } from "../run";
import { runSlackMentionFlow } from "./slack-helpers";

export const slackMention: Scenario = {
  name: "slack-mention",
  order: 80,
  // Rendered by both legs of .github/workflows/slack-visuals.yml.
  groups: ["visuals-legacy", "visuals-v2"],
  async run(ctx) {
    expect(ctx.slack.apiCalls("auth.test").length > 0, "Bolt never called auth.test on the mock");
    expect(
      ctx.slack.apiCalls("apps.connections.open").length > 0,
      "Bolt never called apps.connections.open on the mock",
    );
    expect(
      ctx.slack.hub.connectionCount === 1,
      `Expected one socket mode connection, found ${ctx.slack.hub.connectionCount}`,
    );

    await runSlackMentionFlow(ctx, "e2e-lead-mention");
  },
};
