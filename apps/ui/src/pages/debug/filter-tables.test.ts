import { describe, expect, test } from "bun:test";
import { filterTables } from "./filter-tables";

const TABLES = ["agents", "agent_tasks", "Swarm_Config", "memories"];

describe("filterTables", () => {
  test("returns every table for an empty or blank query", () => {
    expect(filterTables(TABLES, "")).toEqual(TABLES);
    expect(filterTables(TABLES, "   ")).toEqual(TABLES);
  });

  test("matches substrings case-insensitively", () => {
    expect(filterTables(TABLES, "AGENT")).toEqual(["agents", "agent_tasks"]);
    expect(filterTables(TABLES, "config")).toEqual(["Swarm_Config"]);
  });

  test("returns an empty list when nothing matches", () => {
    expect(filterTables(TABLES, "zzz")).toEqual([]);
  });
});
