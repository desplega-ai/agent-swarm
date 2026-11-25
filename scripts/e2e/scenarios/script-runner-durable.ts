import { sql } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { startScriptRunner } from "../script-runner";

export const scriptRunnerDurable: Scenario = {
  name: "script-runner-durable",
  order: 501,
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
    // SQLite uses its existing local path. These placement checks require PostgreSQL.
    for (const signal of ["SIGTERM", "SIGKILL", "SIGSTOP"] as const) {
      const first = startScriptRunner(ctx.baseUrl, token);
      const runners = [first];
      try {
        expect(
          await pollUntil(
            async () =>
              asRecords((await ctx.api("GET", "/api/script-runners")).json, "sessions").length ===
              1,
            20000,
          ),
          "first runner connects",
        );
        const firstId = asString(
          asRecords((await ctx.api("GET", "/api/script-runners")).json, "sessions")[0]!.instanceId,
          "first instance",
        );
        runners.push(startScriptRunner(ctx.baseUrl, token));
        expect(
          await pollUntil(
            async () =>
              asRecords((await ctx.api("GET", "/api/script-runners")).json, "sessions").length ===
              2,
            20000,
          ),
          "second runner connects",
        );
        const launch = await ctx.api("POST", "/api/script-runs", {
          agentId,
          body: {
            source: `export default async (_, ctx) => {
          const first = await ctx.step.swarmScript("first", { source: "export default () => 41" });
          await new Promise(resolve => setTimeout(resolve, 15000));
          const second = await ctx.step.swarmScript("second", { source: "export default () => 1" });
          const third = await ctx.step.swarmScript("third", { source: "export default () => 0" });
          return [first, second, third];
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
        const owned = ctx.db.get<{ ownerId: string; pid: number | null }>(
          sql`SELECT "ownerId", pid FROM script_runs WHERE id = ${id}`,
        );
        expect(
          owned?.ownerId === firstId && owned.pid === null,
          "first remote runner owns run with NULL PID",
        );
        const interruptedAt = Date.now();
        if (signal === "SIGSTOP") first.signal("SIGSTOP");
        else await first.stop(signal);
        let result: Record<string, unknown> = {};
        expect(
          await pollUntil(
            async () => {
              result = asRecord((await ctx.api("GET", `/api/script-runs/${id}`)).json);
              return asRecord(result.run).status === "completed";
            },
            signal === "SIGTERM" ? 45000 : 105000,
          ),
          `durable run completes after ${signal}`,
        );
        const settled = ctx.db.get<{ ownerId: string }>(
          sql`SELECT "ownerId" FROM script_runs WHERE id = ${id}`,
        );
        expect(settled?.ownerId !== firstId, "replay changes the owner");
        expect(asRecords(result, "journal").length === 3, "replay stores each step once");
        if (signal === "SIGTERM")
          expect(Date.now() - interruptedAt < 60000, "drain does not wait for lease expiry");
        // Cancellation must stop another remote guest and retain the public terminal state.
        const cancellable = await ctx.api("POST", "/api/script-runs", {
          agentId,
          body: {
            source:
              "export default async () => { await new Promise(resolve => setTimeout(resolve, 60000)); return 42; }",
          },
        });
        const cancelId = asString(asRecord(cancellable.json).id, "cancel run ID");
        expectStatus(
          await ctx.api("DELETE", `/api/script-runs/${cancelId}`),
          [204],
          "cancel remote guest",
        );
        expect(
          asRecord(asRecord((await ctx.api("GET", `/api/script-runs/${cancelId}`)).json).run)
            .status === "cancelled",
          "cancel remains terminal",
        );
      } finally {
        await Promise.all(runners.map((runner) => runner.stop("SIGKILL")));
        expect(
          await pollUntil(
            async () =>
              asRecords((await ctx.api("GET", "/api/script-runners")).json, "sessions").length ===
              0,
            20000,
          ),
          "runner sessions close",
        );
      }
    }
    await ctx.restartSut({ env: { SCRIPT_EMBEDDED_RUNNER_SLOTS: "0" } });
    const shared = startScriptRunner(ctx.baseUrl, token, 4);
    const queuedIds: string[] = [];
    try {
      expect(
        await pollUntil(
          async () =>
            asRecords((await ctx.api("GET", "/api/script-runners")).json, "sessions").length === 1,
          20000,
        ),
        "shared runner connects",
      );
      for (let index = 0; index < 4; index++) {
        const created = await ctx.api("POST", "/api/script-runs", {
          agentId,
          body: {
            source:
              "export default async () => { await new Promise(resolve => setTimeout(resolve, 20000)); return 42; }",
          },
        });
        expectStatus(created, [201], "long lane launch");
        queuedIds.push(asString(asRecord(created.json).id, "queued run ID"));
      }
      const lane = asRecord(
        asRecord(asRecord((await ctx.api("GET", "/api/script-runners")).json).lanes).long,
      );
      expect(
        lane.inFlight === 2 && lane.queued === 2,
        "long lane leaves shared slots for sync work",
      );
      const since = Date.now();
      const sync = await ctx.api("POST", "/api/scripts/run", {
        agentId,
        body: { source: "export default () => 42", executor: "native" },
      });
      expectStatus(sync, [200], "sync work beside durable jobs");
      expect(
        asRecord(sync.json).result === 42 && Date.now() - since < 2000,
        "sync work completes within two seconds",
      );
      for (const id of queuedIds) await ctx.api("DELETE", `/api/script-runs/${id}`);
      const restartRun = await ctx.api("POST", "/api/script-runs", {
        agentId,
        body: {
          source: `export default async (_, ctx) => {
        await ctx.step.swarmScript("before-restart", { source: "export default () => 41" });
        await new Promise(resolve => setTimeout(resolve, 20000));
        return await ctx.step.swarmScript("after-restart", { source: "export default () => 42" });
      }`,
        },
      });
      const restartId = asString(asRecord(restartRun.json).id, "restart run ID");
      expect(
        await pollUntil(
          async () =>
            asRecords(
              asRecord((await ctx.api("GET", `/api/script-runs/${restartId}`)).json),
              "journal",
            ).length === 1,
          20000,
        ),
        "journal records the first step before API restart",
      );
      await ctx.restartSut({ env: { SCRIPT_EMBEDDED_RUNNER_SLOTS: "0" } });
      let restarted: Record<string, unknown> = {};
      expect(
        await pollUntil(async () => {
          restarted = asRecord((await ctx.api("GET", `/api/script-runs/${restartId}`)).json);
          return asRecord(restarted.run).status === "completed";
        }, 70000),
        "durable run replays after API restart",
      );
      expect(
        asRecords(restarted, "journal").length === 2,
        "API restart preserves each journal step once",
      );
    } finally {
      for (const id of queuedIds) await ctx.api("DELETE", `/api/script-runs/${id}`);
      await shared.stop("SIGKILL");
      await ctx.restartSut();
    }
    const embedded = await ctx.api("POST", "/api/script-runs", {
      agentId,
      body: {
        source:
          "export default async () => { await new Promise(resolve => setTimeout(resolve, 40000)); return 42; }",
      },
    });
    const embeddedId = asString(asRecord(embedded.json).id, "embedded run ID");
    expect(
      await pollUntil(
        async () =>
          asRecord(asRecord((await ctx.api("GET", `/api/script-runs/${embeddedId}`)).json).run)
            .status === "completed",
        55000,
      ),
      "40-second embedded run completes",
    );
    const embeddedOwner = ctx.db.get<{ ownerId: string; leaseExpiresAt: string | null }>(
      sql`SELECT "ownerId", "leaseExpiresAt" FROM script_runs WHERE id = ${embeddedId}`,
    );
    expect(
      embeddedOwner?.ownerId.startsWith("embedded:") && embeddedOwner.leaseExpiresAt === null,
      "embedded ownership never expires",
    );
  },
};
