import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
    "a level past the budget fills the budget instead of dropping its tests",
    async () => {
      // Fixture repo: src/types.ts has more direct test importers than the budget,
      // and src/mid.ts (which imports types) reaches a second level past what is left.
      const dir = await mkdtemp(join(tmpdir(), "affected-tests-"));
      try {
        await Bun.write(join(dir, "scripts/pre-push-affected-tests.ts"), Bun.file(SELECTOR));
        await Bun.write(join(dir, "src/types.ts"), "export const value = 1;\n");
        await Bun.write(join(dir, "src/hub.ts"), "export const hub = 1;\n");
        await Bun.write(join(dir, "src/mid.ts"), 'export { value } from "./types";\n');
        const write = (name: string, from: string) =>
          Bun.write(join(dir, "tests", name), `import "../src/${from}";\n`);
        for (let i = 0; i < 6; i++) await write(`edge-${i}.test.ts`, "hub");
        for (let i = 0; i < 2; i++) await write(`direct-${i}.test.ts`, "types");
        for (let i = 0; i < 6; i++) await write(`deep-${i}.test.ts`, "mid");
        await write("types-mid.test.ts", "mid");
        await Bun.$`git init -q && git add -A`.cwd(dir).quiet();

        const run = async (file: string) =>
          (
            await Bun.$`bun scripts/pre-push-affected-tests.ts ${file}`
              .cwd(dir)
              .env({ ...process.env, PRE_PUSH_TESTS_BUDGET: "5" })
              .quiet()
              .text()
          )
            .split("\n")
            .filter(Boolean);

        // First level alone passes the budget: a stable nonempty sample, not zero.
        const hub = await run("src/hub.ts");
        expect(hub).toEqual([0, 1, 2, 3, 4].map((i) => `./tests/edge-${i}.test.ts`));
        expect(await run("src/hub.ts")).toEqual(hub);

        // Lower level kept, named test kept, the rest of the overflowing level fills to 5.
        expect(await run("src/types.ts")).toEqual([
          "./tests/deep-0.test.ts",
          "./tests/deep-1.test.ts",
          "./tests/direct-0.test.ts",
          "./tests/direct-1.test.ts",
          "./tests/types-mid.test.ts",
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
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
