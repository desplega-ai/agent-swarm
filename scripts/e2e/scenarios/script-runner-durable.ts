import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { startScriptRunner } from "../script-runner";

export const scriptRunnerDurable: Scenario = {
  name: "script-runner-durable",
  order: 498,
  async run(ctx) {
    const minted = await ctx.api("POST", "/api/script-runners/credentials", {
      body: {
        name: `durable-${ctx.nonce}`,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    });
    if (ctx.db.engine === "sqlite") {
      expectStatus(minted, [409], "SQLite refuses runner credentials");
      return;
    }
    expectStatus(minted, [201], "mint runner credential");
    const token = asString(asRecord(minted.json).token, "token");
    const agent = await ctx.api("POST", "/api/agents", {
      body: { name: `durable-${ctx.nonce}`, role: "worker", status: "online" },
    });
    const agentId = asString(asRecord(agent.json).id, "agent ID");
    const runners = [startScriptRunner(ctx.baseUrl, token), startScriptRunner(ctx.baseUrl, token)];
    try {
      expect(
        await pollUntil(
          async () =>
            asRecords((await ctx.api("GET", "/api/script-runners")).json, "sessions").length === 2,
          20000,
        ),
        "two runners connect",
      );
      const launch = await ctx.api("POST", "/api/script-runs", {
        agentId,
        body: {
          source: `export default async (_, ctx) => {
        const first = await ctx.step.swarmScript("first", { source: "export default () => 41" });
        await new Promise(resolve => setTimeout(resolve, 2500));
        const second = await ctx.step.swarmScript("second", { source: "export default () => 1" });
        return [first, second];
      }`,
        },
      });
      expectStatus(launch, [201], "launch durable guest");
      const id = asString(asRecord(launch.json).id, "run ID");
      expect(
        await pollUntil(
          async () =>
            asRecords(asRecord((await ctx.api("GET", `/api/script-runs/${id}`)).json), "journal")
              .length >= 1,
          20000,
        ),
        "first journal step finishes",
      );
      // First connected runner owns the launch. A graceful drain clears ownership immediately.
      await runners[0]!.stop("SIGTERM");
      let result: Record<string, unknown> = {};
      expect(
        await pollUntil(async () => {
          result = asRecord((await ctx.api("GET", `/api/script-runs/${id}`)).json);
          return asRecord(result.run).status === "completed";
        }, 40000),
        "durable guest completes after drain",
      );
      const journal = asRecords(result, "journal");
      expect(journal.length === 2, "replay stores each step once");
      expect(asRecord(result.run).pid === undefined, "remote PID stays absent");
    } finally {
      await Promise.all(runners.map((runner) => runner.stop("SIGKILL")));
    }
  },
};
