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
import { dirname, join, relative, resolve } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

type Workflow = {
  jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }>;
};

// The GitHub expression the step uses for the diff base; the test substitutes a local branch.
const BASE_REF_EXPR = ["$", "{{ steps.base.outputs.ref }}"].join("");
const REPO_ROOT = resolve(import.meta.dir, "../..");
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/merge-gate.yml");
const PRE_PUSH_PATH = join(REPO_ROOT, "scripts/pre-push-tests.sh");
const PRELOAD_PATH = join(REPO_ROOT, "src/tests/preload.ts");

/**
 * Repo-relative files the test preload loads: relative imports plus `new URL("./x", import.meta.url)`
 * worker entries, followed transitively inside src/tests/. `local` = src/tests/ files (reached
 * only through the preload); `external` = the preload's direct imports elsewhere in src/.
 */
async function preloadClosure(): Promise<{ local: string[]; external: string[] }> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const testsDir = join(REPO_ROOT, "src/tests");
  const local = new Set<string>();
  const external = new Set<string>();
  const queue = [PRELOAD_PATH];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const rel = relative(REPO_ROOT, file);
    if (local.has(rel)) continue;
    local.add(rel);
    const src = await Bun.file(file).text();
    const specs = transpiler.scanImports(src).map((i) => i.path);
    for (const m of src.matchAll(/new URL\(\s*["'](\.[^"']+)["']\s*,\s*import\.meta\.url/g)) {
      if (m[1]) specs.push(m[1]);
    }
    for (const spec of specs) {
      if (!spec.startsWith(".")) continue;
      let target = resolve(dirname(file), spec);
      if (!target.endsWith(".ts")) target += ".ts";
      if (target.startsWith(`${testsDir}/`)) queue.push(target);
      else external.add(relative(REPO_ROOT, target));
    }
  }
  return { local: [...local].sort(), external: [...external].sort() };
}

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

/** Builds the repo and returns the change-flag step's flags, for `event` when given. */
async function flagsFor(
  files: string[],
  change: (repo: string) => Promise<void>,
  script?: string,
  event?: string,
): Promise<Record<string, string>> {
  const repo = await repoWith(files, change);
  const { stdout, outputs } = await runStep(
    repo,
    script ?? (await loadFlagStep()),
    event ? { EVENT_NAME: event } : {},
  );
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

/**
 * Repo-relative src/ files the dashboard bundle reads: relative imports in apps/ui/src
 * (tests excluded) and the `../../src/...` paths its vite configs name.
 */
async function dashboardSrcInputs(): Promise<string[]> {
  const loaders = {
    ts: new Bun.Transpiler({ loader: "ts" }),
    tsx: new Bun.Transpiler({ loader: "tsx" }),
  };
  const uiRoot = join(REPO_ROOT, "apps/ui");
  const found = new Set<string>();
  const keep = (file: string, spec: string) => {
    const rel = relative(REPO_ROOT, resolve(dirname(file), spec));
    if (rel.startsWith("src/")) found.add(rel);
  };
  for await (const path of new Bun.Glob("src/**/*.{ts,tsx}").scan({ cwd: uiRoot })) {
    if (/\.test\.tsx?$/.test(path)) continue;
    const file = join(uiRoot, path);
    const transpiler = path.endsWith(".tsx") ? loaders.tsx : loaders.ts;
    for (const { path: spec } of transpiler.scanImports(await Bun.file(file).text())) {
      if (spec.startsWith(".")) keep(file, spec);
    }
  }
  for await (const path of new Bun.Glob("vite*.config.ts").scan({ cwd: uiRoot })) {
    const file = join(uiRoot, path);
    for (const m of (await Bun.file(file).text()).matchAll(
      /["'`]((?:\.\.\/)+src\/[^"'`]+)["'`]/g,
    )) {
      if (m[1]) keep(file, m[1]);
    }
  }
  return [...found].sort();
}

describe("merge-gate image builds on a pull request", () => {
  const BASE_FILES = [
    "src/be/db.ts",
    "src/utils/task-citations.ts",
    "scripts/e2e/scenarios/x.ts",
    "scripts/init-local-postgres.sh",
    "apps/ui/src/app.tsx",
    "Dockerfile.worker",
    "Dockerfile.ui",
    "bun.lock",
    ".github/workflows/merge-gate.yml",
  ];

  test.each([
    // [changed file, event, docker, ui_image]
    ["src/be/db.ts", "pull_request", "false", "false"],
    ["src/be/db.ts", "merge_group", "true", "true"],
    ["scripts/e2e/scenarios/x.ts", "pull_request", "false", "false"],
    ["scripts/e2e/scenarios/x.ts", "merge_group", "true", "false"],
    ["scripts/init-local-postgres.sh", "pull_request", "true", "false"],
    ["Dockerfile.worker", "pull_request", "true", "false"],
    ["Dockerfile.ui", "pull_request", "false", "true"],
    ["bun.lock", "pull_request", "true", "true"],
    ["apps/ui/src/app.tsx", "pull_request", "false", "true"],
    ["src/utils/task-citations.ts", "pull_request", "false", "true"],
    [".github/workflows/merge-gate.yml", "pull_request", "true", "true"],
  ])(
    "%s on %s: docker=%s ui_image=%s",
    async (path, event, docker, uiImage) => {
      const flags = await flagsFor(BASE_FILES, edit(path), undefined, event);
      expect(flags.docker).toBe(docker);
      expect(flags.ui_image).toBe(uiImage);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "a source change next to an image input still builds on a pull request",
    async () => {
      const flags = await flagsFor(
        BASE_FILES,
        async (repo) => {
          await edit("src/be/db.ts")(repo);
          await edit("Dockerfile.worker")(repo);
        },
        undefined,
        "pull_request",
      );
      expect(flags.docker).toBe("true");
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  // The pull-request list names the src/ directories the dashboard imports. A new import
  // from another directory must join it, or a pull request that breaks the bundle goes
  // green until the merge queue.
  test("the pull-request Dashboard Image list covers every src/ file the dashboard reads", async () => {
    const step = await loadFlagStep();
    const pattern = /UI_IMAGE=\$\(match '(\^src\/[^']+)'\)/.exec(step)?.[1];
    expect(pattern).toBeDefined();
    const inputs = await dashboardSrcInputs();
    expect(inputs.length).toBeGreaterThan(0);
    const covered = new RegExp(pattern as string);
    expect(inputs.filter((file) => !covered.test(file))).toEqual([]);
  });
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
    "src/tests/hang-watchdog.ts",
    "src/tests/hang-watchdog-worker.ts",
    "src/tests/fixtures/child-write-guard-preload.ts",
    "src/tests/fixtures/profile-write-guard.ts",
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
    "every preload-only bootstrap file runs the full suite in CI and pre-push",
    async () => {
      const { local, external } = await preloadClosure();
      // Positive control: the sweep sees the watchdog thread file only through `new URL`.
      expect(local).toContain("src/tests/hang-watchdog-worker.ts");
      const prePush = (await Bun.file(PRE_PUSH_PATH).text()).match(/^FULL_RUN_PATHS='(.+)'$/m)?.[1];
      if (!prePush) throw new Error("FULL_RUN_PATHS not found in pre-push-tests.sh");
      for (const path of local) {
        expect({ path, scope: (await scopeFor(["src/x.ts"], edit(path))).scope }).toEqual({
          path,
          scope: "full",
        });
        expect({ path, prePush: new RegExp(prePush).test(path) }).toEqual({ path, prePush: true });
      }
      // A preload import outside src/tests/ is safe only while some test imports it too:
      // `--changed` then selects that test, and it fails in the preload.
      const tests = await Promise.all(
        [...new Bun.Glob("src/**/*.test.ts").scanSync(REPO_ROOT)].map((f) =>
          Bun.file(join(REPO_ROOT, f)).text(),
        ),
      );
      for (const path of external) {
        const spec = `/${path.replace(/^src\//, "").replace(/\.ts$/, "")}"`;
        expect({ path, testImporter: tests.some((t) => t.includes(spec)) }).toEqual({
          path,
          testImporter: true,
        });
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test(
    "control: bun test --changed skips every test when only a preload-only import changes",
    async () => {
      const repo = await repoWith(
        [
          ["bunfig.toml", '[test]\npreload = ["./preload.ts"]\n'],
          ["preload.ts", 'import "./dep";\n'],
          ["dep.ts", "export {};\n"],
          ["a.test.ts", 'import { test } from "bun:test";\ntest("a", () => {});\n'],
        ],
        edit("dep.ts", 'throw new Error("preload dependency regression");\n'),
      );
      const env = { ...GIT_ENV, HOME: process.env.HOME ?? tmpdir() };
      const scoped = await runChild([process.execPath, "test", "--changed=base"], {
        cwd: repo,
        env,
      });
      const full = await runChild([process.execPath, "test"], { cwd: repo, env });
      // Scoped: nothing selected, exit 0. Full: the preload throws.
      expect(scoped.exitCode).toBe(0);
      expect(`${scoped.stdout}${scoped.stderr}`).not.toContain("preload dependency regression");
      expect(full.exitCode).not.toBe(0);
      expect(`${full.stdout}${full.stderr}`).toContain("preload dependency regression");
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
