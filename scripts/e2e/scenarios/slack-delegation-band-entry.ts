import type { Scenario } from "../run";
import { enableSlackDelegation } from "./slack-helpers";

// First scenario of shard 4 (SHARD_CUTS in ../shard.ts cuts at 190). Every scenario after
// it used to inherit SLACK_RENDER_V2 and SLACK_RENDER_V2_DELEGATION from
// slack-delegation-child-result (140), which leaves them on for the rest of a process.
// A shard is its own process, so this one sets the same flags before the core, workflow,
// script, knowledge and platform scenarios run. In an unsharded run the flags are already
// on and the helper only confirms them.
export const slackDelegationBandEntry: Scenario = {
  name: "slack-delegation-band-entry",
  order: 190,
  async run(ctx) {
    await enableSlackDelegation(ctx);
  },
};
