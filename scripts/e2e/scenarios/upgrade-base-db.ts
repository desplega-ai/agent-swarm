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

      const applied = fixture.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM _migrations");
      const current = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM _migrations");
      expect(
        Number(applied?.n) === Number(current?.n),
        `upgraded database has ${applied?.n} migrations, a new one has ${current?.n}`,
      );
    } finally {
      await fixture.stop();
    }
  },
};
