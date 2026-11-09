import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

/** Runs the real chown_no_follow block from docker-entrypoint.sh with chown stubbed to a log. */
const entrypoint = readFileSync("docker-entrypoint.sh", "utf8");
const block = entrypoint.slice(
  entrypoint.indexOf("# BEGIN chown_no_follow"),
  entrypoint.indexOf("# END chown_no_follow"),
);

let root = "";
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "entrypoint-chown-")));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Returns the argument lists chown received. */
async function chownCalls(path: string): Promise<string[]> {
  const result = await runChild(
    ["bash", "-c", `chown() { echo "chown $*"; }\n${block}\nchown_no_follow "$1"`, "bash", path],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: CHILD_PROCESS_TEST_BUDGET_MS,
    },
  );
  expectChildOk(result, "chown_no_follow");
  return result.stdout.split("\n").filter((line) => line.startsWith("chown "));
}

describe("docker-entrypoint.sh chown_no_follow", () => {
  test("every root chown of a persistent workspace path uses it", () => {
    expect(entrypoint).toContain("chown_no_follow /workspace/personal\n");
    expect(entrypoint).toContain("chown_no_follow /workspace/personal/memory\n");
    expect(entrypoint).toContain('chown_no_follow "$(dirname "$REPO_DIR")"');
    expect(entrypoint).not.toMatch(/chown [^\n]*\/workspace\/personal/);
  });

  test("chowns a real directory without dereferencing", async () => {
    const dir = join(root, "real");
    mkdirSync(dir);
    expect(await chownCalls(dir)).toEqual([`chown -h worker:worker ${dir}`]);
  });

  test("refuses a planted symlink and a path through a symlinked parent", async () => {
    const secret = join(root, "root-owned");
    writeFileSync(secret, "x");
    const link = join(root, "memory");
    symlinkSync(secret, link);
    const outside = join(root, "outside");
    mkdirSync(join(outside, "repos"), { recursive: true });
    const parent = join(root, "personal");
    symlinkSync(outside, parent);
    expect(await chownCalls(link)).toEqual([]);
    expect(await chownCalls(join(parent, "repos"))).toEqual([]);
  });
});
