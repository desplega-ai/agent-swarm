import type { Scenario } from "../run";
import { enableSlackDelegation } from "./slack-helpers";

// First scenario of shards 4, 5 and 6 (SHARD_CUTS in ../shard.ts cuts at 190, 500 and
// 9006). Every scenario after 140 used to inherit SLACK_RENDER_V2 and
// SLACK_RENDER_V2_DELEGATION from slack-delegation-child-result (140), which leaves them
// on for the rest of a process. A shard is its own process, so each of these sets the same
// flags before the rest of its band runs. In an unsharded run the flags are already on and
// the helper only confirms them.
export const slackDelegationBandEntry: Scenario = {
  name: "slack-delegation-band-entry",
  order: 190,
  async run(ctx) {
    await enableSlackDelegation(ctx);
  },
};

/** First scenario of shard 5: the knowledge and platform bands. */
export const slackDelegationBandEntryKnowledge: Scenario = {
  name: "slack-delegation-band-entry-knowledge",
  order: 500,
  async run(ctx) {
    await enableSlackDelegation(ctx);
  },
};

/** First scenario of shard 6: the storage-engine parity band. */
export const slackDelegationBandEntryStorage: Scenario = {
  name: "slack-delegation-band-entry-storage",
  order: 9006,
  async run(ctx) {
    await enableSlackDelegation(ctx);
  },
};
