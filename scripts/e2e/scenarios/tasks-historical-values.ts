import { loadHistoricalTaskFixture, sql } from "../db";
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

// agent_tasks.status and agent_tasks.source have no CHECK constraint, so a database
// that an older build, an import or a hand edit wrote can hold a value that no current
// build writes. Release 2.14.4 serves such a row as stored. One such row must not hide
// the other tasks of its list page, and the row itself stays readable (issue #3579).
//
// The API boots as a deployment does. Under NODE_ENV=test, `respond()` refuses a response
// that breaks its schema; a deployment logs the violation and sends the response.
export const tasksHistoricalValues: Scenario = {
  name: "tasks-historical-values",
  order: 9_005,
  async run(ctx) {
    const agentId = crypto.randomUUID();
    const current = { id: crypto.randomUUID(), status: "completed", source: "api" };
    const oldStatus = { id: crypto.randomUUID(), status: "in_progres", source: "api" };
    const oldSource = { id: crypto.randomUUID(), status: "pending", source: "legacy-import" };
    const stored = [current, oldStatus, oldSource];
    const fixture = await ctx.startFixtureSut(await loadHistoricalTaskFixture(agentId, stored), {
      NODE_ENV: "production",
    });
    try {
      for (const fields of ["", "&fields=full", "&fields=timeline"]) {
        const page = await fixture.api("GET", `/api/tasks?agentId=${agentId}${fields}`);
        expectStatus(page, [200], `list the page that holds a historical status (${fields})`);
        const listed = asRecords(page.json, "tasks");
        expect(
          listed.length === stored.length,
          `the page lists ${listed.length} of ${stored.length} tasks (${fields}): ${page.text.slice(0, 300)}`,
        );
        for (const task of stored) {
          const row = listed.find((item) => item.id === task.id);
          expect(
            row?.status === task.status,
            `task ${task.id} lists status ${String(row?.status)}, stored ${task.status} (${fields})`,
          );
        }
      }

      const supported = await fixture.api(
        "GET",
        `/api/tasks?agentId=${agentId}&status=completed,pending`,
      );
      expectStatus(supported, [200], "list the tasks with a current status");
      const supportedIds = asRecords(supported.json, "tasks").map((task) => task.id);
      expect(
        supportedIds.length === 2 &&
          [current.id, oldSource.id].every((id) => supportedIds.includes(id)),
        `the status filter lists ${JSON.stringify(supportedIds)}`,
      );

      for (const task of stored) {
        const read = await fixture.api("GET", `/api/tasks/${task.id}`);
        expectStatus(read, [200], `read the task with status ${task.status} by id`);
        const body = asRecord(read.json);
        expect(
          body.status === task.status && body.source === task.source,
          `task ${task.id} reads as ${String(body.status)} / ${String(body.source)}, stored ${task.status} / ${task.source}`,
        );
      }

      const rows = fixture.db.query<{ id: string; status: string; source: string }>(
        sql`SELECT id, status, source FROM agent_tasks WHERE "agentId" = ${agentId}`,
      );
      expect(
        stored.every((task) =>
          rows.some(
            (row) => row.id === task.id && row.status === task.status && row.source === task.source,
          ),
        ),
        `the database holds ${JSON.stringify(rows)}`,
      );
    } finally {
      await fixture.stop();
    }
  },
};
