import { describe, expect, test } from "bun:test";
import {
  countTestCalls,
  judge,
  parseAllowlist,
  type TestChange,
} from "../../scripts/check-unit-test-allowlist";

const allowlist = parseAllowlist(
  [
    "# comment",
    "src/providers/  # harness adapters, worker runtime",
    "src/claude.ts  # Claude CLI launcher, worker runtime",
    "src/tests/legacy-api.test.ts  # escape hatch: a race no scenario can force",
  ].join("\n"),
);

const files: Record<string, string> = {
  "src/tests/helper.ts": 'import { getDb } from "../be/db";\nexport const db = getDb;\n',
};
const read = (path: string) => files[path];

const apiTest = 'import { test } from "bun:test";\nimport { createTask } from "../be/db";\n';
const workerTest =
  'import { test } from "bun:test";\nimport { adapter } from "../providers/claude-adapter";\nimport { run } from "@/claude";\n';

function run(change: TestChange) {
  return judge([change], allowlist, read);
}

describe("rule 1: no new unit tests", () => {
  test("rejects a new test file that imports API code", () => {
    const violations = run({
      path: "src/tests/new-api.test.ts",
      head: `${apiTest}test("a", () => {});\n`,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("new test file");
    expect(violations[0]?.reason).toContain("src/be/db");
  });

  test("rejects a new test( call in an old file that imports API code", () => {
    const base = `${apiTest}test("a", () => {});\n`;
    const head = `${base}test.each([1, 2])("b %d", () => {});\n`;
    const violations = run({ path: "src/tests/old-api.test.ts", base, head });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("1 new test( call(s)");
  });

  test("follows test helpers to the API code they import", () => {
    const head =
      'import { test } from "bun:test";\nimport { db } from "./helper";\ntest("a", () => {});\n';
    const violations = run({ path: "src/tests/via-helper.test.ts", head });
    expect(violations[0]?.reason).toContain("src/be/db (via src/tests/helper.ts)");
  });

  test("accepts a new test file that imports only allowlisted code", () => {
    expect(
      run({ path: "src/tests/new-worker.test.ts", head: `${workerTest}test("a", () => {});\n` }),
    ).toEqual([]);
  });

  test("accepts an old API test file with edits but no new test( call", () => {
    const base = `${apiTest}test("a", () => {});\n`;
    const head = `${apiTest}test("a renamed", () => { expect(1).toBe(1); });\n`;
    expect(run({ path: "src/tests/old-api.test.ts", base, head })).toEqual([]);
  });

  test("accepts a test file listed with a reason (escape hatch)", () => {
    expect(
      run({ path: "src/tests/legacy-api.test.ts", head: `${apiTest}test("a", () => {});\n` }),
    ).toEqual([]);
  });

  test("ignores type-only imports, packages and non-test files", () => {
    const head =
      'import type { Task } from "../types";\nimport { z } from "zod";\ntest("a", () => {});\n';
    expect(run({ path: "src/tests/types-only.test.ts", head })).toEqual([]);
    expect(run({ path: "src/be/new-module.ts", head: apiTest })).toEqual([]);
  });

  test("an allowlist line without a reason is an error", () => {
    expect(() => parseAllowlist("src/be/\n")).toThrow("needs a reason");
  });

  test("counts test( and it( calls with modifiers once each", () => {
    expect(
      countTestCalls('test("a"); it("b"); test.skip("c"); test.if(x)("d"); latest("e");'),
    ).toBe(4);
  });
});
