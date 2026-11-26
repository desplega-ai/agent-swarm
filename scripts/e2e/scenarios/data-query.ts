import { sql } from "../db";
import { asRecord, expect } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  expectRunOk,
  registerAgent,
  runScript,
  structured,
  toolText,
  withMcp,
} from "./script-helpers";
import { configureAgentFs, removeConfigs, startAgentFsStub, storedSheet } from "./sheets-helpers";

const CSV = "e2e/data/sales.csv";
const RESULT = {
  columns: [
    { name: "region", type: "VARCHAR" },
    { name: "=n", type: "BIGINT" },
  ],
  rows: [
    { region: "eu", "=n": 2 },
    { region: "=us", "=n": 1 },
  ],
  rowCount: 2,
  truncated: false,
  files: [{ table: "t0", path: `/${CSV}`, format: "csv" }],
  elapsedMs: 5,
};

/**
 * Flow `data`: `data-query` and `ctx.data.query` proxy the agent-fs `sql` op as the agent's own
 * key. Rows, a card, a sheet, the sqlite and missing-path refusals, agent-fs's own errors, the
 * MCP and script row caps, and one `data.query` event per call without the SQL text.
 */
export const dataQuery: Scenario = {
  name: "data-query",
  order: 602,
  async run(ctx) {
    const fake = startAgentFsStub(ctx, "data");
    const agentId = await registerAgent(ctx, "data-query");
    const configIds = await configureAgentFs(ctx, agentId, fake);
    fake.files.set(CSV, { body: "region,amount\neu,1\n", version: 1 });
    const sqlCalls: Record<string, unknown>[] = [];
    fake.onOp((op) => {
      if (op.op === "stat") {
        const path = String(op.path ?? "").replace(/^\/+/, "");
        return fake.files.has(path)
          ? Response.json({ path: `/${path}`, currentVersion: 1 })
          : Response.json(
              { error: "NOT_FOUND", message: `File not found: /${path}` },
              { status: 404 },
            );
      }
      if (op.op !== "sql") return undefined;
      sqlCalls.push(op);
      if (String(op.query).includes("busy")) {
        return Response.json(
          { error: "VALIDATION_ERROR", message: "Too many SQL queries running (limit 4)" },
          { status: 400 },
        );
      }
      return Response.json(RESULT);
    });
    const query = `SELECT region, count(*) n FROM '/${CSV}' GROUP BY 1 -- ${ctx.nonce}`;
    const sheetPath = `e2e/data/result-${ctx.nonce}.sheet.json`;
    try {
      await withMcp(ctx, agentId, async (mcp) => {
        const rows = structured(await callToolOk(mcp, "data-query", { sql: query, origin: "e2e" }));
        expect(
          rows.rowCount === 2 &&
            rows.output === "rows" &&
            JSON.stringify(rows.rows) === JSON.stringify(RESULT.rows) &&
            sqlCalls[0]?.query === query &&
            sqlCalls[0]?.maxRows === 100 &&
            sqlCalls[0]?.driveId === fake.drive,
          `rows: ${JSON.stringify(rows).slice(0, 400)} / ${JSON.stringify(sqlCalls[0])}`,
        );

        const card = structured(
          await callToolOk(mcp, "data-query", { sql: query, card: true, origin: "e2e" }),
        );
        const table = asRecord(asRecord(asRecord(card.card).elements).table);
        expect(
          table.type === "Table" &&
            JSON.stringify(asRecord(table.props).headers) === `["region","=n"]` &&
            JSON.stringify(asRecord(table.props).rows) === `[["eu","2"],["=us","1"]]`,
          `card: ${JSON.stringify(card.card)}`,
        );

        const sheet = structured(
          await callToolOk(mcp, "data-query", {
            sql: query,
            sheet: { path: sheetPath },
            origin: "e2e",
          }),
        );
        const stored = storedSheet(fake, sheetPath);
        const cells = asRecord(asRecord((stored.tabs as unknown[])[0]).cells);
        expect(
          stored.format === "swarm-sheet/1" &&
            asRecord(cells.A1).v === "region" &&
            asRecord(cells.B1).v === "=n" &&
            asRecord(cells.B1).f === undefined &&
            asRecord(cells.B2).v === 2 &&
            asRecord(cells.A3).v === "=us" &&
            asRecord(cells.A3).f === undefined &&
            typeof asRecord(asRecord(sheet.sheet).object).id === "string",
          `sheet: a header row, then the rows, '=' text kept literal in both: ${JSON.stringify(cells)}`,
        );

        const before = sqlCalls.length;
        const sqlite = await callToolErr(mcp, "data-query", {
          sql: "SELECT * FROM '/e2e/data/app.sqlite'",
          origin: "e2e",
        });
        expect(toolText(sqlite).includes("sqlite"), `sqlite refusal: ${toolText(sqlite)}`);
        const bound = await callToolErr(mcp, "data-query", {
          sql: "SELECT * FROM t",
          tables: { t: { path: `/${CSV}`, format: "duckdb" } },
          origin: "e2e",
        });
        expect(toolText(bound).includes("duckdb"), `duckdb refusal: ${toolText(bound)}`);
        const missing = await callToolErr(mcp, "data-query", {
          sql: "SELECT * FROM '/e2e/data/missing.csv'",
          origin: "e2e",
        });
        expect(
          toolText(missing).includes("File not found: /e2e/data/missing.csv"),
          `missing path: ${toolText(missing)}`,
        );
        const capped = await callToolErr(mcp, "data-query", {
          sql: query,
          maxRows: 5_000,
          origin: "e2e",
        });
        expect(toolText(capped).includes("at most 1000"), `MCP row cap: ${toolText(capped)}`);
        expect(sqlCalls.length === before, "refusals never reach agent-fs sql");

        const busy = await callToolErr(mcp, "data-query", { sql: "SELECT 'busy'", origin: "e2e" });
        expect(
          toolText(busy).includes("Too many SQL queries running") &&
            structured(busy).errorCode === "VALIDATION_ERROR",
          `agent-fs error keeps its text and code: ${toolText(busy)} ${JSON.stringify(structured(busy))}`,
        );
      });

      for (const executor of ["native", "quickjs"] as const) {
        const run = await runScript(
          ctx,
          agentId,
          {
            executor,
            intent: `e2e data ${executor} ${ctx.nonce}`,
            source: `export default async (_args, ctx) => {
  const result = await ctx.data.query({ sql: ${JSON.stringify(query)}, origin: "e2e" });
  const refusal = await ctx.data.query({ sql: "SELECT * FROM '/x/app.duckdb'", origin: "e2e" }).catch((e) => String(e));
  return { rowCount: result.rowCount, success: "success" in result, refusal };
};`,
          },
          `ctx.data ${executor}`,
        );
        expectRunOk(run, `ctx.data ${executor}`);
        const result = asRecord(run.result);
        expect(
          result.rowCount === 2 &&
            result.success === false &&
            String(result.refusal).includes("duckdb") &&
            sqlCalls.at(-1)?.maxRows === 1_000,
          `${executor}: ${JSON.stringify(result)} / maxRows ${String(sqlCalls.at(-1)?.maxRows)}`,
        );
      }

      const events = ctx.db.query<{ status: string; data: string | Record<string, unknown> }>(
        sql`SELECT status, data FROM events WHERE event = 'data.query' AND "agentId" = ${agentId}`,
      );
      const parsed = events.map((e) => ({
        status: e.status,
        data: typeof e.data === "string" ? asRecord(JSON.parse(e.data)) : asRecord(e.data),
      }));
      const ok = parsed.filter((e) => e.status === "ok");
      expect(
        parsed.length === 12 &&
          ok.length === 5 &&
          JSON.stringify(ok.map((e) => e.data.output).sort()) ===
            `["card","rows","rows","rows","sheet"]` &&
          ok.filter((e) => e.data.callOrigin === "script-sdk").length === 2 &&
          parsed.every((e) => e.data.origin === "e2e") &&
          parsed.some((e) => e.data.errorCode === "NOT_FOUND") &&
          parsed.some((e) => e.data.errorCode === "FORMAT_REFUSED") &&
          JSON.stringify(ok[0]?.data.tables) === JSON.stringify([CSV]) &&
          !JSON.stringify(parsed).includes(ctx.nonce),
        `one data.query event per call, no SQL text: ${JSON.stringify(parsed).slice(0, 800)}`,
      );
      expect(fake.authorizedOnlyAsOwner(), "every agent-fs call carries the agent's own key");
    } finally {
      fake.stop();
      await removeConfigs(ctx, configIds);
    }
  },
};
