import { asRecord, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { expectToolOk, registerWorker, withMcp } from "./core-helpers";

// db-query reads a JSON list passed as a string param as JSON text on both engines.
// SQLite: `json_each(?)` with '["a","b","c"]'. Postgres: `$1::jsonb`, `$1::json` and
// `CAST($1 AS jsonb)` with the same string. A real array or object param still works
// on Postgres. A string in a text position, a placeholder in a string literal and a
// placeholder in a comment are not changed.

const LIST = ["a", "b", "c"];
const LIST_TEXT = JSON.stringify(LIST);

type Rows = unknown[][];

async function dbQuery(ctx: ScenarioContext, sql: string, params: unknown[]): Promise<Rows> {
  const response = await ctx.api("POST", "/api/db-query", { body: { sql, params } });
  expectStatus(response, [200], `db-query ${sql}`);
  const rows = asRecord(response.json).rows;
  expect(Array.isArray(rows), `db-query ${sql} returned no rows array: ${response.text}`);
  return rows as Rows;
}

async function activeDialect(ctx: ScenarioContext): Promise<"sqlite" | "postgres"> {
  const response = await ctx.api("POST", "/api/db-query", { body: { sql: "SELECT 1 AS one" } });
  expectStatus(response, [200], "db-query probe");
  return asRecord(response.json).dialect === "postgres" ? "postgres" : "sqlite";
}

async function expectCount(
  ctx: ScenarioContext,
  sql: string,
  params: unknown[],
  want: number,
): Promise<void> {
  const rows = await dbQuery(ctx, sql, params);
  const got = Number(rows[0]?.[0]);
  expect(got === want, `${sql} with ${JSON.stringify(params)}: want ${want} rows, got ${got}`);
}

export const divergenceDbQueryJsonParams: Scenario = {
  name: "divergence-db-query-json-params",
  order: 9_470,
  async run(ctx) {
    const dialect = await activeDialect(ctx);
    const agentId = await registerWorker(ctx, "db-query-json");
    const agentName = `core-db-query-json-${ctx.nonce}`;
    const p = (n: number) => (dialect === "postgres" ? `$${n}` : "?");

    if (dialect === "postgres") {
      // A JSON-text string is parsed as JSON in each cast form.
      for (const sql of [
        "SELECT COUNT(*) AS n FROM jsonb_array_elements_text($1::jsonb)",
        "SELECT COUNT(*) AS n FROM json_array_elements_text($1::json)",
        "SELECT COUNT(*) AS n FROM jsonb_array_elements_text(CAST($1 AS jsonb))",
        "SELECT COUNT(*) AS n FROM jsonb_array_elements_text($1::text::jsonb)",
      ]) {
        await expectCount(ctx, sql, [LIST_TEXT], LIST.length);
      }
      const typed = await dbQuery(ctx, "SELECT jsonb_typeof($1::jsonb) AS t", [LIST_TEXT]);
      expect(typed[0]?.[0] === "array", `a JSON-text list is a ${String(typed[0]?.[0])}`);

      // A real array or object param still binds as JSON.
      await expectCount(
        ctx,
        "SELECT COUNT(*) AS n FROM jsonb_array_elements_text($1::jsonb)",
        [LIST],
        LIST.length,
      );
      const object = await dbQuery(ctx, "SELECT jsonb_array_length($1::jsonb -> 'k') AS n", [
        { k: [1, 2] },
      ]);
      expect(Number(object[0]?.[0]) === 2, `object param read ${JSON.stringify(object)}`);

      // A string that is not JSON text is refused, not stored as a JSON string scalar.
      const bad = await ctx.api("POST", "/api/db-query", {
        body: { sql: "SELECT jsonb_typeof($1::jsonb) AS t", params: ["not json"] },
      });
      expectStatus(bad, [400], "db-query with a non-JSON string cast to jsonb");
      expect(
        /invalid input syntax for type json/i.test(String(asRecord(bad.json).error)),
        `non-JSON string to jsonb: ${bad.text.slice(0, 300)}`,
      );
    } else {
      await expectCount(ctx, "SELECT COUNT(*) AS n FROM json_each(?)", [LIST_TEXT], LIST.length);
    }

    // A string in a text position compares as text.
    const byName = await dbQuery(ctx, `SELECT id FROM agents WHERE name = ${p(1)}`, [agentName]);
    expect(
      JSON.stringify(byName) === JSON.stringify([[agentId]]),
      `agent by name answered ${JSON.stringify(byName)}`,
    );
    const echoed = await dbQuery(ctx, `SELECT CAST(${p(1)} AS text) AS v`, [LIST_TEXT]);
    expect(echoed[0]?.[0] === LIST_TEXT, `a text param came back as ${String(echoed[0]?.[0])}`);

    // A placeholder in a string literal or a comment is plain text.
    const literal = await dbQuery(
      ctx,
      `SELECT 'x $1::jsonb y' AS lit /* $1::jsonb */, CAST(${p(1)} AS text) AS v`,
      [LIST_TEXT],
    );
    expect(
      literal[0]?.[0] === "x $1::jsonb y" && literal[0]?.[1] === LIST_TEXT,
      `literal query answered ${JSON.stringify(literal)}`,
    );

    // The MCP tool takes the same path.
    const toolSql =
      dialect === "postgres"
        ? "SELECT COUNT(*) AS n FROM jsonb_array_elements_text($1::jsonb)"
        : "SELECT COUNT(*) AS n FROM json_each(?)";
    await withMcp(ctx, agentId, async (conn) => {
      const outcome = await expectToolOk(conn, "db-query", { sql: toolSql, params: [LIST_TEXT] });
      const rows = outcome.data.rows as Rows | undefined;
      expect(
        Number(rows?.[0]?.[0]) === LIST.length,
        `MCP db-query answered ${JSON.stringify(outcome.data)}`,
      );
    });
  },
};
