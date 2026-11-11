import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  countTestCalls,
  isTestFile,
  judge,
  parseAllowlist,
  type TestChange,
} from "../../scripts/check-unit-test-allowlist";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc";

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

  // Every name `bun test` 1.4 runs, probed in an empty directory: four suffixes, eight
  // extensions, any letter case.
  const discovered = ["test", "spec", "TEST", "Spec"].flatMap((word) =>
    ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "TS"].flatMap((ext) => [
      `src/tests/new-api.${word}.${ext}`,
      `src/tests/new-api_${word}.${ext}`,
    ]),
  );

  test("judges every file name bun test discovers", () => {
    for (const path of discovered) {
      expect({ path, test: isTestFile(path) }).toEqual({ path, test: true });
      const violations = run({ path, head: `${apiTest}test("a", () => {});\n` });
      expect({ path, violations: violations.length }).toEqual({ path, violations: 1 });
    }
  });

  test("leaves names bun test does not discover alone", () => {
    for (const path of [
      "src/tests/new-api-test.ts",
      "src/tests/new-api.tests.ts",
      "src/tests/test.ts",
      "src/tests/new-api.test.d.ts",
      "src/tests/new-api.test.json",
      "node_modules/pkg/a.spec.ts",
    ]) {
      expect({ path, test: isTestFile(path) }).toEqual({ path, test: false });
    }
  });
});

describe("rule 1 CLI against a git diff", () => {
  const checker = join(import.meta.dir, "../../scripts/check-unit-test-allowlist.ts");
  let repo = "";
  let base = "";

  const git = async (...args: string[]) => {
    const result = await runChild(
      ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
      { cwd: repo },
    );
    expect(result.exitCode).toBe(0);
    return result.stdout.trim();
  };
  const put = async (path: string, text: string) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  };
  const check = () => runChild(["bun", checker, "--base", base], { cwd: repo });

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "rule1-cli-"));
    await git("init", "-q");
    await put("scripts/unit-test-allowlist.txt", "src/providers/  # harness adapters\n");
    await put("src/be/db.ts", "export const getDb = () => 1;\n");
    await put("src/tests/notes.ts", `${apiTest}test("parked", () => {});\n`);
    await git("add", "-A");
    await git("commit", "-q", "-m", "base");
    base = await git("rev-parse", "HEAD");
  });
  afterAll(() => rm(repo, { recursive: true, force: true }));

  test(
    "fails a new .spec.ts that imports API code",
    async () => {
      await put("src/tests/foo.spec.ts", `${apiTest}test("a", () => {});\n`);
      const result = await check();
      await rm(join(repo, "src/tests/foo.spec.ts"));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("src/tests/foo.spec.ts: new test file");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "fails a helper renamed into a test name",
    async () => {
      await git("mv", "src/tests/notes.ts", "src/tests/notes.test.ts");
      const result = await check();
      await git("mv", "src/tests/notes.test.ts", "src/tests/notes.ts");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("src/tests/notes.test.ts: new test file");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "passes a name bun test does not run",
    async () => {
      await put("src/tests/foo-test.ts", `${apiTest}test("a", () => {});\n`);
      const result = await check();
      await rm(join(repo, "src/tests/foo-test.ts"));
      expect(result.exitCode).toBe(0);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
