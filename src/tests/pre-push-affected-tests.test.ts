import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// Runs scripts/pre-push-affected-tests.ts against this checkout, so the controls
// below use files that exist in the repo.
const REPO_ROOT = resolve(import.meta.dir, "../..");
const SELECTOR = join(REPO_ROOT, "scripts/pre-push-affected-tests.ts");
const SELECTOR_BUDGET_MS = 30_000;

async function select(...changed: string[]): Promise<string[]> {
  const out = await Bun.$`bun ${SELECTOR} ${changed}`.cwd(REPO_ROOT).quiet().text();
  return out.split("\n").filter(Boolean);
}

describe("pre-push affected-test selector", () => {
  test(
    "a changed test selects itself; a deleted one selects nothing",
    async () => {
      expect(await select("src/tests/pre-push-affected-tests.test.ts")).toEqual([
        "./src/tests/pre-push-affected-tests.test.ts",
      ]);
      expect(await select("src/tests/does-not-exist.test.ts")).toEqual([]);
    },
    SELECTOR_BUDGET_MS,
  );

  test(
    "a hub file stays within the budget and keeps its named tests",
    async () => {
      // src/utils/secret-scrubber.ts reaches ~870 test files through the import graph.
      const picked = await select("src/utils/secret-scrubber.ts");
      expect(picked.length).toBeGreaterThan(0);
      expect(picked.length).toBeLessThanOrEqual(40);
      expect(picked).toContain("./src/tests/secret-scrubber.test.ts");
    },
    SELECTOR_BUDGET_MS,
  );

  test(
    "a migration selects every migration test",
    async () => {
      const migrations = (await readdir(join(REPO_ROOT, "src/be/migrations"))).filter((f) =>
        f.endsWith(".sql"),
      );
      const picked = await select(`src/be/migrations/${migrations[0]}`);
      const migrationTests = (await readdir(join(REPO_ROOT, "src/tests"))).filter(
        (f) => f.includes("migration") && f.endsWith(".test.ts"),
      );
      expect(migrationTests.length).toBeGreaterThan(0);
      for (const t of migrationTests) expect(picked).toContain(`./src/tests/${t}`);
    },
    SELECTOR_BUDGET_MS,
  );
});
