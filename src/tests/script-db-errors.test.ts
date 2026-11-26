import { describe, expect, test } from "bun:test";
import { createScriptDb, dbQueryRows, selectDialectSql } from "../scripts-runtime/script-db";
import { SwarmToolError } from "../scripts-runtime/swarm-tool-error";

const SQL_SHAPE =
  "ctx.db.query: sql must be a string or an object { sqlite: string; postgres: string }";
const NO_ROWS = "ctx.db.query: db_query returned no rows";

describe("ctx.db.query errors", () => {
  test("a bad sql shape and a success reply without rows throw a typed SwarmToolError", async () => {
    for (const sql of [null, undefined, 42, ["select 1"], { sqlite: "select 1" }]) {
      expect(() => selectDialectSql(sql, "sqlite")).toThrow(
        expect.objectContaining({ code: "invalid_args", tool: "db_query", message: SQL_SHAPE }),
      );
    }
    for (const reply of [
      { success: true, data: {} },
      { success: true },
      { success: true, data: { rows: "x" } },
    ]) {
      let thrown: unknown;
      try {
        dbQueryRows(reply);
      } catch (error) {
        thrown = error;
      }
      expect(thrown instanceof SwarmToolError).toBe(true);
      expect(thrown).toMatchObject({ code: "upstream", tool: "db_query", message: NO_ROWS });
    }

    // The path both executors run: ctx.db.query over the run's db_query call.
    const db = createScriptDb("sqlite", async () => ({ success: true, status: 200, data: {} }));
    await expect(db.query("select 1")).rejects.toMatchObject({
      name: "SwarmToolError",
      code: "upstream",
      tool: "db_query",
      message: NO_ROWS,
    });
    await expect(db.query(null as never)).rejects.toMatchObject({
      name: "SwarmToolError",
      code: "invalid_args",
      tool: "db_query",
      message: SQL_SHAPE,
    });
  });
});
