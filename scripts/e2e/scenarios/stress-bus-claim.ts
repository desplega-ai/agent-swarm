import { sql, sqlList } from "../db";
import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { registerAgent } from "./script-helpers";

export const stressBusClaim: Scenario = {
  name: "stress-bus-claim",
  order: 9451,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "bus-stress");
    const ids: string[] = [];
    // Four batches keep the public durable cap intact while publishes race claims.
    for (let batch = 0; batch < 4; batch++) {
      const runs = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          ctx.api("POST", "/api/script-runs", {
            agentId,
            body: { background: true, source: `export default async () => ${batch * 5 + index};` },
          }),
        ),
      );
      const batchIds = runs.map((r) => {
        expectStatus(r, [201], "launch bus stress run");
        return asString(asRecord(r.json).id, "run id");
      });
      ids.push(...batchIds);
      expect(
        await pollUntil(async () => {
          const rows = await Promise.all(
            batchIds.map((id) => ctx.api("GET", `/api/script-runs/${id}`)),
          );
          return rows.every((r) => asRecord(asRecord(r.json).run).status === "completed");
        }, 60_000),
        "all public launches complete",
      );
    }
    if (ctx.db.engine === "sqlite") {
      expect(
        ctx.db.get<{ n: number }>("SELECT count(*) n FROM sqlite_master WHERE name='bus_events'")
          ?.n === 0,
        "SQLite retains the existing path without bus tables",
      );
      return;
    }
    expect(
      await pollUntil(() => {
        const row = ctx.db.get<{
          n: number;
        }>(sql`SELECT count(*) n FROM bus_deliveries d JOIN bus_events e ON e.id=d."eventId"
        WHERE e.payload->>'runId' IN (${sqlList(ids)}) AND d.status='delivered'`);
        return row?.n === 20;
      }, 30_000),
      "twenty launches deliver twenty dispatcher events",
    );
    const counts = ctx.db.get<{ events: number; deliveries: number; attempts: number }>(sql`
      SELECT count(*) events, count(d."eventId") deliveries, sum(d.attempts) attempts
      FROM bus_events e JOIN bus_deliveries d ON d."eventId"=e.id WHERE e.payload->>'runId' IN (${sqlList(ids)})`);
    expect(counts?.events === 20 && counts.deliveries === 20, "one event and delivery per launch");
    ctx.log(`bus launches: ${JSON.stringify(counts)}`);
  },
};

export const busLaunchRecovery: Scenario = {
  name: "bus-launch-recovery",
  order: 9452,
  async run(ctx) {
    if (ctx.db.engine !== "postgres") return;
    const agentId = await registerAgent(ctx, "bus-recovery");
    const key = `bus-crash-${ctx.nonce}`;
    try {
      await ctx.restartSut({ env: { E2E_BUS_RECOVERY_ONLY: "true" } });
      const deferred = await ctx.api("POST", "/api/script-runs", {
        agentId,
        body: { source: "export default async () => 1;", background: false },
      });
      expectStatus(deferred, [201], "defer a public launch in its originating boot");
      const deferredId = asString(asRecord(deferred.json).id, "deferred run id");
      expect(
        await pollUntil(
          () =>
            ctx.db.get<{ status: string }>(sql`
        SELECT d.status FROM bus_deliveries d JOIN bus_events e ON e.id=d."eventId"
        WHERE e.payload->>'runId'=${deferredId}`)?.status === "delivered",
          10_000,
        ),
        "the same boot acknowledges its deferred event",
      );
      const deferredRun = asRecord(
        asRecord((await ctx.api("GET", `/api/script-runs/${deferredId}`)).json).run,
      );
      expect(
        deferredRun.status === "running" && !deferredRun.pid,
        "the bus preserves same-boot background:false deferral",
      );
      await ctx.api("DELETE", `/api/script-runs/${deferredId}`);
      await ctx.restartSut({ env: { E2E_BUS_ROLLBACK_LAUNCH: "true" } });
      const rolled = await ctx.api("POST", "/api/script-runs", {
        agentId,
        body: { source: "export default async () => 1;", idempotencyKey: key, background: false },
      });
      expectStatus(rolled, [500], "fault rolls back the public launch");
      expect(
        ctx.db.get<{ n: number }>(
          sql`SELECT count(*) n FROM script_runs WHERE "idempotencyKey"=${key}`,
        )?.n === 0,
        "the transaction retains no run",
      );
      expect(
        ctx.db.get<{ n: number }>(
          sql`SELECT count(*) n FROM bus_events e LEFT JOIN script_runs r ON e.payload->>'runId'=r.id WHERE r.id IS NULL`,
        )?.n === 0,
        "rollback retains no orphan event",
      );
      await ctx.restartSut({ env: { E2E_BUS_CRASH_AFTER_LAUNCH: "true" } });
      try {
        await ctx.api("POST", "/api/script-runs", {
          agentId,
          body: {
            source: "export default async () => 42;",
            idempotencyKey: key,
            background: false,
          },
        });
      } catch {
        /* The API exits after COMMIT, before responding. */
      }
      const row = ctx.db.get<{ id: string }>(
        sql`SELECT id FROM script_runs WHERE "idempotencyKey"=${key}`,
      );
      expect(!!row, "crash occurs after launch commit");
      const id = row!.id;
      expect(
        ctx.db.get<{ status: string }>(
          sql`SELECT d.status FROM bus_deliveries d JOIN bus_events e ON e.id=d."eventId" WHERE e.payload->>'runId'=${id}`,
        )?.status === "pending",
        "crash leaves a pending delivery",
      );
      // Disable only the reconciliation scan. Delivery must start this run itself.
      await ctx.restartSut({ env: { E2E_BUS_RECOVERY_ONLY: "true" } });
      expect(
        await pollUntil(async () => {
          const r = await ctx.api("GET", `/api/script-runs/${id}`);
          return asRecord(asRecord(r.json).run).status === "completed";
        }, 60_000),
        "pending delivery starts the run after API restart",
      );
      expect(
        ctx.db.get<{ attempts: number }>(
          sql`SELECT d.attempts FROM bus_deliveries d JOIN bus_events e ON e.id=d."eventId" WHERE e.payload->>'runId'=${id}`,
        )?.attempts === 1,
        "recovered bus claims the delivery once",
      );
    } finally {
      await ctx.restartSut();
    }
  },
};
