import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

/** Runs the real prepare_clone_target block from docker-entrypoint.sh against scratch dirs. */
const entrypoint = readFileSync("docker-entrypoint.sh", "utf8");
const block = entrypoint.slice(
  entrypoint.indexOf("# BEGIN prepare_clone_target"),
  entrypoint.indexOf("# END prepare_clone_target"),
);

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "entrypoint-clone-target-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function prepare(dir: string) {
  const result = await runChild(
    ["bash", "-c", `${block}\nprepare_clone_target "$1"`, "bash", dir],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: CHILD_PROCESS_TEST_BUDGET_MS,
    },
  );
  expectChildOk(result, "prepare_clone_target");
  return result.stdout;
}

describe("docker-entrypoint.sh prepare_clone_target", () => {
  test("the clone path calls it", () => {
    expect(block).toContain("prepare_clone_target()");
    expect(entrypoint).toContain('prepare_clone_target "$REPO_DIR"');
  });

  test("leaves a missing, an empty and a git directory alone", async () => {
    const missing = join(root, "missing");
    await prepare(missing);
    expect(existsSync(missing)).toBe(false);
    const empty = join(root, "empty");
    mkdirSync(empty);
    await prepare(empty);
    expect(readdirSync(empty)).toEqual([]);
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "file"), "kept");
    await prepare(repo);
    expect(readdirSync(repo).sort()).toEqual([".git", "file"]);
  });

  test("moves a non-empty directory without .git aside with its content intact", async () => {
    const parent = join(root, "repos");
    const partial = join(parent, "x");
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, "work.txt"), "unsaved");
    expect(await prepare(partial)).toContain("Moved incomplete clone");
    expect(existsSync(partial)).toBe(false);
    const [aside] = readdirSync(parent);
    expect(aside).toMatch(/^x\.incomplete-\d+$/);
    expect(readFileSync(join(parent, aside!, "work.txt"), "utf8")).toBe("unsaved");
  });
});
