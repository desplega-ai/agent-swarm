import { asRecord, expect } from "../http";
import type { Scenario } from "../run";
import { expectRunOk, registerAgent, runScript, upsertScript } from "./script-helpers";

// Saved (so `script_upsert` typechecks `ctx.db` against the generated types), then run by name.
const SOURCE = `import type { ScriptContext } from "swarm-sdk";
export default async function (args: { agentName: string }, ctx: ScriptContext) {
  const portable = await ctx.db.query<{ name: string }>(
    "SELECT name FROM agents WHERE name = $1",
    [args.agentName],
  );
  const picked = await ctx.db.query({
    sqlite: "SELECT 'sqlite-text' AS picked",
    postgres: "SELECT 'postgres-text' AS picked",
  });
  const badSql = "SELECT * FROM e2e_no_such_table";
  const raw = (await ctx.swarm.db_query({ sql: badSql })) as any;
  let queryError = "";
  try {
    await ctx.db.query(badSql);
  } catch (error) {
    queryError = error instanceof Error ? error.message : String(error);
  }
  let shapeError = "";
  try {
    await ctx.db.query({ sqlite: "SELECT 1" } as any);
  } catch (error) {
    shapeError = error instanceof Error ? error.message : String(error);
  }
  const probe = (await ctx.swarm.db_query({ sql: "SELECT 1 AS one" })) as any;
  return {
    dialect: ctx.db.dialect,
    responseDialect: probe?.data?.dialect,
    portable,
    picked,
    rawFailure: { success: raw?.success, status: raw?.status, error: raw?.data?.error },
    queryError,
    shapeError,
  };
}`;

/**
 * Flow `script-db-dialect`: `ctx.db.dialect` equals the storage engine of the API (no probe
 * query), `ctx.db.query` returns the rows of a portable statement as objects, runs only the
 * text of the active dialect from a per-dialect object, fails with the error of `db_query`
 * for bad SQL, and rejects an object without both texts. Both executors, both engines.
 */
export const scriptDbDialect: Scenario = {
  name: "script-db-dialect",
  order: 506,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "db-dialect");
    const agentName = `e2e-script-db-dialect-${ctx.nonce}`;
    const name = `e2e-db-dialect-${ctx.nonce}`;
    await upsertScript(ctx, agentId, { name, source: SOURCE, intent: "typecheck ctx.db" });
    const engine = ctx.db.engine;

    for (const executor of ["native", "quickjs"]) {
      const label = `ctx.db (${executor}, ${engine})`;
      const run = await runScript(ctx, agentId, {
        name,
        args: { agentName },
        executor,
        intent: `verify ${label}`,
      });
      expectRunOk(run, label);
      const result = asRecord(run.result);
      expect(result.dialect === engine, `${label}: dialect ${String(result.dialect)}`);
      expect(
        result.responseDialect === engine,
        `${label}: db_query response dialect ${String(result.responseDialect)}`,
      );
      expect(
        JSON.stringify(result.portable) === JSON.stringify([{ name: agentName }]),
        `${label}: portable query rows ${JSON.stringify(result.portable)}`,
      );
      expect(
        JSON.stringify(result.picked) === JSON.stringify([{ picked: `${engine}-text` }]),
        `${label}: per-dialect query ran the wrong text: ${JSON.stringify(result.picked)}`,
      );
      const raw = asRecord(result.rawFailure);
      expect(
        raw.success === false && typeof raw.error === "string" && raw.error !== "",
        `${label}: bad SQL did not fail db_query: ${JSON.stringify(raw)}`,
      );
      expect(
        result.queryError === `ctx.db.query failed with ${String(raw.status)}: ${String(raw.error)}`,
        `${label}: query error differs from db_query: ${String(result.queryError)}`,
      );
      expect(
        result.shapeError ===
          "ctx.db.query: sql must be a string or an object { sqlite: string; postgres: string }",
        `${label}: shape error ${String(result.shapeError)}`,
      );
    }
  },
};
