import { describe, expect, test } from "bun:test";
import { DbQueryInputSchema, resolveDbQuerySql } from "../http/db-query";

describe("db-query input compatibility", () => {
  test("canonical sql input resolves to sql", () => {
    const parsed = DbQueryInputSchema.parse({ sql: "SELECT 1", params: [] });

    expect(resolveDbQuerySql(parsed)).toBe("SELECT 1");
  });

  test("legacy query input remains a runtime alias", () => {
    const parsed = DbQueryInputSchema.parse({ query: "SELECT 2" });

    expect(resolveDbQuerySql(parsed)).toBe("SELECT 2");
  });

  test("sql takes precedence when both sql and query are present", () => {
    const parsed = DbQueryInputSchema.parse({ sql: "SELECT 3", query: "SELECT 4" });

    expect(resolveDbQuerySql(parsed)).toBe("SELECT 3");
  });

  test("rejects input without sql or query", () => {
    const parsed = DbQueryInputSchema.safeParse({});

    expect(parsed.success).toBe(false);
  });
});
