import type { Scenario } from "../run";
import { runSlackMentionFlow } from "./slack-helpers";
import { enableNativeHttp, expectNativeTransport } from "./slack-http-helpers";

/** The Socket Mode mention round trip, over signed HTTP requests to the native receiver. */
export const slackHttpMention: Scenario = {
  name: "slack-http-mention",
  order: 176,
  async run(ctx) {
    const flip = await enableNativeHttp(ctx);
    try {
      await runSlackMentionFlow(flip.ctx, "e2e-lead-http-mention");
      await expectNativeTransport(ctx, flip);
    } finally {
      await flip.undo();
    }
  },
};
