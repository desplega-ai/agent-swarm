import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

/**
 * Runs the real repo auto-clone loop from docker-entrypoint.sh against a
 * scratch repos.json. gosu, git and gh are stubbed: git and gh log their argv
 * one element per line, so the test can check that every repo field reaches
 * the command as exactly one argument and is never parsed as shell.
 */
const entrypoint = readFileSync("docker-entrypoint.sh", "utf8");
const loopStart = entrypoint.indexOf(
  "jq -c '.repos[]' /tmp/swarm_repos.json | while read -r repo; do",
);
const loopEnd = entrypoint.indexOf("\n            done\n", loopStart);
const loop = entrypoint
  .slice(loopStart, loopEnd + "\n            done\n".length)
  .replace("/tmp/swarm_repos.json", '"$REPOS_JSON"');

let root = "";
let bin = "";
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "entrypoint-autoclone-")));
  bin = join(root, "bin");
  mkdirSync(bin);
  // Each stub appends its name and argv (one element per line) to $ARGV_LOG.
  const stub = (name: string, extra = "") =>
    `#!/usr/bin/env bash\n{ echo "== ${name}"; for a in "$@"; do printf '%s\\n' "$a"; done; } >> "$ARGV_LOG"\n${extra}exit 0\n`;
  writeFileSync(join(bin, "gh"), stub("gh"));
  writeFileSync(
    join(bin, "git"),
    stub("git", 'if [ "$1" = branch ]; then echo "$CURRENT_BRANCH"; fi\n'),
  );
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "git"), 0o755);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Repo {
  url: string;
  name: string;
  clonePath: string;
  defaultBranch: string;
}

async function runLoop(caseDir: string, repo: Repo, currentBranch = repo.defaultBranch) {
  const reposJson = join(caseDir, "repos.json");
  const argvLog = join(caseDir, "argv.log");
  writeFileSync(reposJson, JSON.stringify({ repos: [{ ...repo, hooks: { enabled: false } }] }));
  writeFileSync(argvLog, "");
  const result = await runChild(
    [
      "bash",
      "-c",
      [
        'gosu() { shift; "$@"; }',
        "chown() { :; }",
        "chown_no_follow() { :; }",
        "prepare_clone_target() { :; }",
        loop,
      ].join("\n"),
    ],
    {
      cwd: caseDir,
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        REPOS_JSON: reposJson,
        ARGV_LOG: argvLog,
        CURRENT_BRANCH: currentBranch,
      },
      timeoutMs: CHILD_PROCESS_TEST_BUDGET_MS,
    },
  );
  expectChildOk(result, "repo auto-clone loop");
  return readFileSync(argvLog, "utf8");
}

function freshCase(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("docker-entrypoint.sh repo auto-clone", () => {
  test("located the loop", () => {
    expect(loopStart).toBeGreaterThan(-1);
    expect(loopEnd).toBeGreaterThan(loopStart);
  });

  test("control: plain fields reach gh and git unchanged", async () => {
    const dir = freshCase("plain");
    const clonePath = join(dir, "repos", "r");
    const cloneLog = await runLoop(dir, {
      url: "https://github.com/o/r",
      name: "r",
      clonePath,
      defaultBranch: "main",
    });
    expect(cloneLog).toContain(
      `== gh\nrepo\nclone\nhttps://github.com/o/r\n${clonePath}\n--\n--branch\nmain\n--single-branch\n`,
    );

    mkdirSync(join(clonePath, ".git"), { recursive: true });
    const syncLog = await runLoop(dir, {
      url: "https://github.com/o/r",
      name: "r",
      clonePath,
      defaultBranch: "main",
    });
    expect(syncLog).toContain("== git\nreset\n--hard\norigin/main\n");
  });

  test("a quote in the url stays inside the url argument", async () => {
    const dir = freshCase("url");
    const marker = join(dir, "marker");
    const url = `https://github.com/o/r'; touch '${marker}'; echo '`;
    const log = await runLoop(dir, {
      url,
      name: "r",
      clonePath: join(dir, "repos", "r"),
      defaultBranch: "main",
    });
    expect(existsSync(marker)).toBe(false);
    expect(log.split("\n")).toContain(url);
  });

  test("a quote in the url stays inside the url argument for plain git hosts", async () => {
    const dir = freshCase("url-git");
    const marker = join(dir, "marker");
    const url = `https://gitlab.example.com/o/r'; touch '${marker}'; echo '`;
    const log = await runLoop(dir, {
      url,
      name: "r",
      clonePath: join(dir, "repos", "r"),
      defaultBranch: "main",
    });
    expect(existsSync(marker)).toBe(false);
    expect(log.split("\n")).toContain(url);
  });

  test("a quote in the clone path stays inside the path argument", async () => {
    const dir = freshCase("path");
    const marker = join(dir, "marker");
    const clonePath = join(dir, "repos", `r'; touch '${marker}'; echo '`);
    const log = await runLoop(dir, {
      url: "https://github.com/o/r",
      name: "r",
      clonePath,
      defaultBranch: "main",
    });
    expect(existsSync(marker)).toBe(false);
    expect(log.split("\n")).toContain(clonePath);
  });

  test("a quote in the default branch stays inside the branch argument when syncing", async () => {
    const dir = freshCase("branch-sync");
    const marker = join(dir, "marker");
    const clonePath = join(dir, "repos", "r");
    mkdirSync(join(clonePath, ".git"), { recursive: true });
    const branch = `main'; touch '${marker}'; echo '`;
    await runLoop(dir, {
      url: "https://github.com/o/r",
      name: "r",
      clonePath,
      defaultBranch: branch,
    });
    expect(existsSync(marker)).toBe(false);
  });

  test("a url or branch that starts with a dash is skipped, never passed to git as an option", async () => {
    const dir = freshCase("dash");
    const clonePath = join(dir, "repos", "r");
    mkdirSync(join(clonePath, ".git"), { recursive: true });
    const branchLog = await runLoop(dir, {
      url: "https://github.com/o/r",
      name: "r",
      clonePath,
      defaultBranch: "--upload-pack=true",
    });
    const urlLog = await runLoop(dir, {
      url: "--upload-pack=true",
      name: "r",
      clonePath: join(dir, "repos", "fresh"),
      defaultBranch: "main",
    });
    expect(branchLog).not.toContain("--upload-pack");
    expect(urlLog).not.toContain("--upload-pack");
  });
});
