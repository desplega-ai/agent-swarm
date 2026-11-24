import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";

// Seeded schedule prompts tell an agent to run SQL through db-query, which runs the
// dialect of the active engine. The seeder keeps only the `<!-- dialect:<name> -->`
// sections of that dialect, as it does for seeded skills. This scenario reads each
// seeded prompt back, checks that only the active dialect's text is left, and runs
// every ```sql block of the prompt through db-query on the engine of this run.

const SCHEDULES = ["daily-status-report", "daily-blocker-digest"] as const;

async function activeDialect(ctx: ScenarioContext): Promise<"sqlite" | "postgres"> {
  const response = await ctx.api("POST", "/api/db-query", { body: { sql: "SELECT 1 AS one" } });
  expectStatus(response, [200], "db-query probe");
  // An absent `dialect` field means SQLite.
  return asRecord(response.json).dialect === "postgres" ? "postgres" : "sqlite";
}

async function seededTemplate(ctx: ScenarioContext, name: string): Promise<string> {
  const response = await ctx.api("GET", `/api/schedules?${new URLSearchParams({ name, fields: "full" })}`);
  expectStatus(response, [200], `list schedule ${name}`);
  const row = asRecords(response.json, "schedules").find((s) => s.name === name);
  expect(row !== undefined, `seeded schedule ${name} is missing`);
  return asString(row?.taskTemplate, `${name} taskTemplate`);
}

/** The statements of every ```sql block, without the trailing `;` (db-query refuses `;`). */
function sqlStatements(template: string): string[] {
  const blocks = [...template.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  return blocks.flatMap((block) =>
    block
      .split(/;\s*(?:\n|$)/)
      .map((sql) => sql.trim())
      .filter(Boolean),
  );
}

export const divergenceSeededScheduleSql: Scenario = {
  name: "divergence-seeded-schedule-sql",
  order: 9_150,
  async run(ctx) {
    const dialect = await activeDialect(ctx);
    for (const name of SCHEDULES) {
      const template = await seededTemplate(ctx, name);
      expect(
        !template.includes("<!-- dialect:") && !template.includes("<!-- /dialect -->"),
        `${name}: the seeded prompt still holds dialect markers`,
      );
      const sqliteText = template.includes("datetime(");
      const postgresText = template.includes("now() - interval '");
      expect(
        dialect === "sqlite" ? sqliteText && !postgresText : postgresText && !sqliteText,
        `${name}: the seeded prompt holds the wrong dialect for ${dialect}`,
      );

      const statements = sqlStatements(template);
      expect(statements.length > 0, `${name}: no SQL block in the seeded prompt`);
      for (const sql of statements) {
        const response = await ctx.api("POST", "/api/db-query", { body: { sql } });
        expectStatus(response, [200], `${name} on ${dialect}: ${sql.slice(0, 160)}`);
        const result = asRecord(response.json);
        expect(
          Array.isArray(result.columns) && Array.isArray(result.rows),
          `${name} on ${dialect}: no columns or rows: ${response.text.slice(0, 300)}`,
        );
      }
    }
  },
};
