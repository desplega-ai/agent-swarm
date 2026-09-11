import { expectStatus } from "../http";
import type { Scenario } from "../run";

export const health: Scenario = {
  name: "health",
  order: 10,
  async run(ctx) {
    expectStatus(await ctx.api("GET", "/health"), [200], "health");
  },
};
