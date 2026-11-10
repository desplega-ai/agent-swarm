import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

/**
 * Runs the real prepare_clone_target block from docker-entrypoint.sh against
 * scratch dirs, with gosu stubbed to log its user and run the command.
 */
const entrypoint = readFileSync("docker-entrypoint.sh", "utf8");
const block = entrypoint.slice(
  entrypoint.indexOf("# BEGIN prepare_clone_target"),
  entrypoint.indexOf("# END prepare_clone_target"),
);

let root = "";
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "entrypoint-clone-target-")));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function prepare(dir: string) {
  const result = await runChild(
    [
      "bash",
      "-c",
      `gosu() { echo "gosu $1"; shift; "$@"; }\n${block}\nprepare_clone_target "$1"`,
      "bash",
      dir,
    ],
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
    const out = await prepare(partial);
    expect(out).toContain("gosu worker");
    expect(out).toContain("Moved incomplete clone");
    expect(existsSync(partial)).toBe(false);
    const [aside] = readdirSync(parent);
    expect(aside).toMatch(/^x\.incomplete-\d+$/);
    expect(readFileSync(join(parent, aside!, "work.txt"), "utf8")).toBe("unsaved");
  });

  test("refuses a planted symlink and a path through a symlinked parent", async () => {
    // Root-owned target outside the workspace the worker wants relocated.
    const outside = join(root, "outside");
    mkdirSync(join(outside, "secret"), { recursive: true });
    writeFileSync(join(outside, "secret", "data"), "root");

    const reposDir = join(root, "ws-repos");
    mkdirSync(reposDir);
    const linkedDir = join(reposDir, "linked");
    symlinkSync(join(outside, "secret"), linkedDir);
    const out = await prepare(linkedDir);
    expect(out).toContain("resolves through a symlink");
    expect(out).not.toContain("gosu");

    const linkedParent = join(root, "linked-parent");
    symlinkSync(outside, linkedParent);
    const viaParent = join(linkedParent, "secret");
    const out2 = await prepare(viaParent);
    expect(out2).toContain("resolves through a symlink");
    expect(out2).not.toContain("gosu");

    expect(readdirSync(outside)).toEqual(["secret"]);
    expect(readFileSync(join(outside, "secret", "data"), "utf8")).toBe("root");
  });
});
