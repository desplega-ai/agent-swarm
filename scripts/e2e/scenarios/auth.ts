import { expectStatus } from "../http";
import type { Scenario } from "../run";

export const auth: Scenario = {
  name: "auth",
  async run(ctx) {
    expectStatus(
      await ctx.api("GET", "/api/tasks", { apiKey: null }),
      [401],
      "request without authorization",
    );
    expectStatus(
      await ctx.api("GET", "/api/tasks", { apiKey: "incorrect-e2e-key" }),
      [401],
      "request with wrong key",
    );
    expectStatus(await ctx.api("GET", "/api/tasks"), [200], "request with correct key");
  },
};
