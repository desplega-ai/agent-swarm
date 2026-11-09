import { expect, pollUntil } from "../http";
import type { Scenario } from "../run";
import { enableNativeHttp, expectNativeTransport } from "./slack-http-helpers";

/** Slash commands as signed form posts; the handler acks inside Slack's budget and replies ephemerally. */
export const slackHttpCommand: Scenario = {
  name: "slack-http-command",
  order: 177,
  async run(ctx) {
    const flip = await enableNativeHttp(ctx);
    try {
      const slack = flip.mock;
      for (const [command, header] of [
        ["/agent-swarm-help", "Agent Swarm Help"],
        ["/agent-swarm-status", "Agent Swarm Status"],
      ] as const) {
        const startedAt = Date.now();
        const { ack } = await slack.slashCommand({
          command,
          user: "alice",
          channel: "general",
        });
        expect(ack.attempts === 1, `${command} needed ${ack.attempts} attempts`);
        expect(
          Date.now() - startedAt < 3_000,
          `${command} took ${Date.now() - startedAt}ms to ack, over Slack's 3s budget`,
        );
        // The reply goes to the command's response_url, which the mock serves.
        const replied = await pollUntil(
          () =>
            slack.ephemeralMessages().some((message) => JSON.stringify(message).includes(header)),
          30_000,
        );
        expect(replied, `${command} produced no ephemeral reply with a "${header}" header`);
      }
      expect(
        slack.ephemeralMessages().length >= 2,
        `Expected two ephemeral replies, found ${slack.ephemeralMessages().length}`,
      );
      await expectNativeTransport(ctx, flip);
    } finally {
      await flip.undo();
    }
  },
};
