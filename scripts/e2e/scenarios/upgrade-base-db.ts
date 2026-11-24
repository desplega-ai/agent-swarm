import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

// Check 10 of the storage-engine brief: a database that the base commit made (fixture
// base-db, built by scripts/e2e/fixtures/make-base-db.ts) boots on the current code,
// gets the newer migrations, and serves its old rows and new writes.
export const upgradeBaseDb: Scenario = {
  name: "upgrade-base-db",
  order: 9_000,
  async run(ctx) {
    const fixture = await ctx.startFixtureSut("base-db");
    try {
      const meta = fixture.meta as {
        agentId: string;
        taskId: string;
        scheduleId: string;
        config: Record<string, string>;
      };

      const agent = await fixture.api("GET", `/api/agents/${meta.agentId}`);
      expectStatus(agent, [200], "old agent");
      expect(asRecord(agent.json).name === "base-fixture-worker", `old agent name: ${agent.text}`);

      const task = await fixture.api("GET", `/api/tasks/${meta.taskId}`);
      expectStatus(task, [200], "old task");
      expect(task.text.includes('"base fixture task"'), `old task: ${task.text.slice(0, 300)}`);

      const schedule = await fixture.api("GET", `/api/schedules/${meta.scheduleId}`);
      expectStatus(schedule, [200], "old schedule");
      expect(
        schedule.text.includes("base-fixture-schedule"),
        `old schedule: ${schedule.text.slice(0, 300)}`,
      );

      for (const [key, value] of Object.entries(meta.config)) {
        const listed = asRecords(
          (await fixture.api("GET", `/api/config?scope=global&key=${key}&includeSecrets=true`))
            .json,
          "configs",
        );
        expect(
          listed[0]?.value === value,
          `old config ${key} reads back as ${String(listed[0]?.value)}`,
        );
      }

      const created = await fixture.api("POST", "/api/tasks", {
        body: {
          task: `after upgrade ${ctx.nonce}`,
          agentId: meta.agentId,
          routingReason: "human_pinned",
          source: "api",
        },
      });
      expectStatus(created, [201], "new task on the upgraded database");

      // The upgraded database holds every migration a new database holds. On
      // Postgres it also keeps the SQLite history older than the Postgres chain:
      // db-copy carries it (queries read migration 307's applied_at), so compare
      // the current versions and check the legacy rows apart.
      const versions = (db: typeof ctx.db) =>
        db
          .query<{ version: number }>("SELECT version FROM _migrations ORDER BY version")
          .map((row) => Number(row.version));
      const upgraded = versions(fixture.db);
      const fresh = versions(ctx.db);
      const missing = fresh.filter((v) => !upgraded.includes(v));
      expect(
        missing.length === 0,
        `upgraded database misses migrations ${missing.join(", ")} that a new one has`,
      );
      const chainStart = fresh[0] ?? 0;
      const extra = upgraded.filter((v) => !fresh.includes(v));
      if (fixture.db.engine === "postgres") {
        expect(
          extra.length > 0 && extra.every((v) => v < chainStart),
          `upgraded Postgres database: copied legacy history ${extra.slice(0, 5).join(", ")}... must all be older than the chain start ${chainStart}`,
        );
      } else {
        expect(
          extra.length === 0,
          `upgraded database has migrations ${extra.join(", ")} that a new one lacks`,
        );
      }
    } finally {
      await fixture.stop();
    }
  },
};
