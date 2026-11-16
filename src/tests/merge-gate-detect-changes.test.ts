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

async function loadScopeStep(): Promise<string> {
  const wf = Bun.YAML.parse(await Bun.file(WORKFLOW_PATH).text()) as Workflow;
  const step = wf.jobs["detect-changes"]?.steps.find((s) => s.id === "test-scope");
  if (!step?.run) throw new Error("detect-changes step `test-scope` not found in merge-gate.yml");
  return step.run;
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

/** Builds a repo whose `base` branch holds `files`, then commits `change` on top as HEAD. */
async function repoWith(
  files: Array<string | [path: string, body: string]>,
  change: (repo: string) => Promise<void>,
): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "merge-gate-flags-"));
  dirs.push(repo);
  await git(repo, "init", "-q", "-b", "base");
  for (const entry of files) {
    const [f, body] = typeof entry === "string" ? [entry, `${BODY}\n// ${entry}\n`] : entry;
    await mkdir(dirname(join(repo, f)), { recursive: true });
    await writeFile(join(repo, f), body);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  await git(repo, "checkout", "-qb", "pr");
  await change(repo);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "pr");
  return repo;
}

/** Runs `script` in `repo` and returns what it wrote to GITHUB_OUTPUT. */
async function runStep(
  repo: string,
  script: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; outputs: Record<string, string> }> {
  const out = join(repo, ".gh-output");
  const res = expectChildOk(
    await runChild(["bash", "-c", script], {
      cwd: repo,
      env: { ...GIT_ENV, ...env, GITHUB_OUTPUT: out },
    }),
    "workflow step",
  );
  const outputs: Record<string, string> = {};
  for (const line of (await Bun.file(out).text()).split("\n")) {
    const [k, v] = line.split("=");
    if (k && v) outputs[k] = v;
  }
  return { stdout: res.stdout, outputs };
}

/** Builds the repo and returns the change-flag step's flags. */
async function flagsFor(
  files: string[],
  change: (repo: string) => Promise<void>,
  script?: string,
): Promise<Record<string, string>> {
  const repo = await repoWith(files, change);
  const { stdout, outputs } = await runStep(repo, script ?? (await loadFlagStep()));
  expect(stdout).toContain("Changed files:");
  return outputs;
}

/** Builds the repo and returns the unit-test scope step's outputs for `event`. */
async function scopeFor(
  files: Array<string | [path: string, body: string]>,
  change: (repo: string) => Promise<void>,
  event = "pull_request",
): Promise<Record<string, string>> {
  const repo = await repoWith(files, change);
  return (await runStep(repo, await loadScopeStep(), { EVENT_NAME: event })).outputs;
}

const edit =
  (path: string, body = "edited\n") =>
  async (repo: string) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), body);
  };

const mv = (from: string, to: string) => async (repo: string) => {
  await mkdir(dirname(join(repo, to)), { recursive: true });
  await git(repo, "mv", from, to);
};

describe("merge-gate detect-changes flags", () => {
  test.each([
    "src/types.ts",
    "src/providers/swarm-events-shared.ts",
    "src/be/db.ts",
    "packages/model-catalog/src/index.ts",
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "tsconfig.json",
    "scripts/check-script-types-freshness.sh",
  ])(
    "%s runs script and extension type freshness checks",
    async (path) => {
      const flags = await flagsFor([path], async (repo) => {
        await Bun.write(join(repo, path), "edited\n");
      });
      expect(flags.script_types).toBe("true");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

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
      expect(flags.script_types).toBe("false");
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

describe("merge-gate unit-test scope", () => {
  test(
    "a leaf source change on a pull request runs only the affected tests",
    async () => {
      const scope = await scopeFor(["src/tools/leaf.ts"], edit("src/tools/leaf.ts"));
      expect(scope.scope).toBe("changed");
      expect(scope.base).toMatch(/^[0-9a-f]{40}$/);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test.each([
    "src/be/migrations/999_new.sql",
    "templates/skills/x/content.md",
    "src/tests/preload.ts",
    "bunfig.toml",
    "tsconfig.json",
    "bun.lock",
    ".github/workflows/merge-gate.yml",
  ])(
    "%s runs the full suite on a pull request",
    async (path) => {
      expect((await scopeFor(["src/x.ts"], edit(path))).scope).toBe("full");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a package.json version bump alone stays scoped; a dependency change runs everything",
    async () => {
      const pkg = (version: string, dep: string) =>
        `{\n  "name": "x",\n  "version": "${version}",\n  "dependencies": { "a": "${dep}" }\n}\n`;
      const base: Array<[string, string]> = [["package.json", pkg("1.0.0", "1.0.0")]];
      const bump = await scopeFor(base, edit("package.json", pkg("1.0.1", "1.0.0")));
      expect(bump.scope).toBe("changed");
      const dep = await scopeFor(base, edit("package.json", pkg("1.0.0", "2.0.0")));
      expect(dep.scope).toBe("full");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "the merge queue always runs the full suite",
    async () => {
      const scope = await scopeFor(["src/tools/leaf.ts"], edit("src/tools/leaf.ts"), "merge_group");
      expect(scope.scope).toBe("full");
      expect(scope.base).toBeUndefined();
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
