/**
 * Runs the merge gate's "Compute per-domain change flags" step, verbatim from
 * .github/workflows/merge-gate.yml, against throwaway git repos.
 *
 * Regression: a rename from a covered path to an excluded one (src/x.ts ->
 * docs/x.ts) used to list only the destination, so the E2E Contract job (and
 * every other src/-keyed flag) skipped a PR that removed a server input.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

type Workflow = {
  jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }>;
};

// The GitHub expression the step uses for the diff base; the test substitutes a local branch.
const BASE_REF_EXPR = ["$", "{{ steps.base.outputs.ref }}"].join("");
const WORKFLOW_PATH = join(import.meta.dir, "../../.github/workflows/merge-gate.yml");

async function loadFlagStep(): Promise<string> {
  const wf = Bun.YAML.parse(await Bun.file(WORKFLOW_PATH).text()) as Workflow;
  const step = wf.jobs["detect-changes"]?.steps.find((s) => s.id === "check");
  if (!step?.run) throw new Error("detect-changes step `check` not found in merge-gate.yml");
  return step.run.replaceAll(BASE_REF_EXPR, "base");
}

// Isolate from the host's git config (a global diff.renames=false would make
// the positive control pass for the wrong reason).
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]) {
  return expectChildOk(await runChild(["git", ...args], { cwd, env: GIT_ENV }), `git ${args[0]}`);
}

// Large enough that git's default rename detection pairs the two sides.
const BODY = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join("\n");

/** Builds a repo whose `base` branch holds `files`, applies `change` on HEAD, and returns the step's flags. */
async function flagsFor(
  files: string[],
  change: (repo: string) => Promise<void>,
  script?: string,
): Promise<Record<string, string>> {
  const repo = await mkdtemp(join(tmpdir(), "merge-gate-flags-"));
  dirs.push(repo);
  await git(repo, "init", "-q", "-b", "base");
  for (const f of files) {
    await mkdir(dirname(join(repo, f)), { recursive: true });
    await writeFile(join(repo, f), `${BODY}\n// ${f}\n`);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  await git(repo, "checkout", "-qb", "pr");
  await change(repo);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "pr");

  const out = join(repo, ".gh-output");
  const res = expectChildOk(
    await runChild(["bash", "-c", script ?? (await loadFlagStep())], {
      cwd: repo,
      env: { ...GIT_ENV, GITHUB_OUTPUT: out },
    }),
    "flag step",
  );
  expect(res.stdout).toContain("Changed files:");
  const flags: Record<string, string> = {};
  for (const line of (await Bun.file(out).text()).split("\n")) {
    const [k, v] = line.split("=");
    if (k && v) flags[k] = v;
  }
  return flags;
}

const mv = (from: string, to: string) => async (repo: string) => {
  await mkdir(dirname(join(repo, to)), { recursive: true });
  await git(repo, "mv", from, to);
};

describe("merge-gate detect-changes flags", () => {
  test(
    "renaming a server file out of src/ still runs E2E",
    async () => {
      const flags = await flagsFor(["src/critical.ts"], mv("src/critical.ts", "docs/critical.ts"));
      expect(flags.e2e).toBe("true");
      expect(flags.test).toBe("true");
      expect(flags.lint).toBe("true");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "renaming a docs file into src/ runs E2E",
    async () => {
      const flags = await flagsFor(["docs/notes.ts"], mv("docs/notes.ts", "src/notes.ts"));
      expect(flags.e2e).toBe("true");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a docs-only change skips E2E, tests, and lint",
    async () => {
      const flags = await flagsFor(["src/critical.ts", "docs/readme.md"], async (repo) => {
        await writeFile(join(repo, "docs/readme.md"), "edited\n");
      });
      expect(flags.e2e).toBe("false");
      expect(flags.test).toBe("false");
      expect(flags.lint).toBe("false");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "control: with rename detection on, the outbound move hides from E2E",
    async () => {
      const step = await loadFlagStep();
      expect(step).toContain("git diff --no-renames --name-only");
      const flags = await flagsFor(
        ["src/critical.ts"],
        mv("src/critical.ts", "docs/critical.ts"),
        step.replace("git diff --no-renames --name-only", "git diff --name-only"),
      );
      expect(flags.e2e).toBe("false");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
