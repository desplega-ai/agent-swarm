import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, DeterministicCheck, JudgeContext, Scenario } from "../src/types.ts";
import { clamp01, safeStringify, taskToolUses } from "./orchestration-utils.ts";

/**
 * real-diff-agent-fs (Code, 1 worker, capability)
 * -----------------------------------------------
 * The other code scenarios plant a bug in a toy module. This one hands the agent
 * a REAL merged change: desplega-ai/agent-fs PR #73, "normalize file paths in
 * every op". The agent gets the whole repo (a bun monorepo, 128 core source files)
 * at the fix's parent commit, installed and ready, and only a bug report: the
 * symptom, with no list of ops, tables or edge cases. It must commit on a branch
 * and `git push` to a sandbox-local bare remote. The grader never looks at the
 * agent's working tree: it clones the pushed ref fresh, drops the fix's own tests on
 * top and runs them. Those tests were never in the sandbox.
 *
 * Why this should separate configs: the fix is wide, not deep. Twenty-five ops take
 * a path, a path lands in six tables plus the event bus, and directory prefixes
 * follow different rules than file paths. A model that patches the ops it noticed
 * and stops earns the families it reached, and one that normalizes every prefix
 * like a file path breaks sibling-prefix exclusion.
 *
 * Fixture: scenarios/fixtures/real-diff-agent-fs/ (see SOURCE.md there).
 *   hidden/    the fix's two test files, overlaid at grading time
 *   solution/  the fix's non-test change under packages/core/src/ops, as a patch
 * The repo itself is not vendored: the seed downloads the parent's tarball and
 * checks the git commit id of the result against SEED_SHA.
 *
 * Grading (all deterministic, nothing the agent says is trusted):
 *   - gate `pushed-branch`: a commit other than the seed reached the remote.
 *     Working-tree-only changes fail it and score 0 on every check below.
 *   - gate `no-upstream-lookup`: the fix is public, so a run that fetched it from
 *     GitHub or the npm package is disqualified.
 *   - `correctness` (8): seven groups of the fix's own tests, run on a fresh clone of
 *     the pushed ref. A group scores 1 when every test in it is green, else 0. Six are
 *     fix groups, one per family of ops, over the 18 tests that fail on the parent. The
 *     seventh, `prior-behavior-kept`, holds 16 tests that already pass on the parent and
 *     guard behavior the issue never mentions (sibling-prefix exclusion, trailing slashes);
 *     it earns credit only when the branch changed op source.
 *   - `delivery` (1): the push, and the share of the rest of the core suite still green.
 *   - `efficiency` (1): deterministic, cost and time against the budgets.
 *
 * Why correctness carries 8 of 10: delivery and efficiency are near-constant for any
 * run that pushes, so at 6/2/1 they hand every config a flat third of the score and
 * hide the spread. See the pilot in the PR.
 */

// ---- sandbox layout ----

const REPO = "/workspace/agent-fs";
const REMOTE = "/workspace/remotes/agent-fs.git";
const GRADE_DIR = "/tmp/grade-agent-fs";
const BUN = "/usr/local/bin/bun";
const UPSTREAM = "desplega-ai/agent-fs";

/** The fix's parent commit (what the tarball is fetched at). */
const PARENT_SHA = "201a2ec778a0a06eeac7ce3dd16778b087e86e58";
/**
 * Commit id of the seeded repo: the parent's tree, one commit, fixed identity and
 * date. The seed command fails when the download does not reproduce it.
 */
const SEED_SHA = "cb14e416eb64551decbe3af6ba751b0cbb2b61f1";
const SEED_DATE = "2026-07-31T12:00:00+0000";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "real-diff-agent-fs");
const OPS_TESTS = "packages/core/src/ops/__tests__";
const PATH_TEST = `${OPS_TESTS}/path-normalization.test.ts`;
const COMMENT_TEST = `${OPS_TESTS}/comment.test.ts`;

function fixture(rel: string): string {
  return readFileSync(join(FIXTURE_DIR, `${rel}.txt`), "utf8");
}

/** The fix's tests, overlaid on the pushed clone at grading time. Never seeded. */
const HIDDEN_FILES = [
  { path: PATH_TEST, content: fixture("hidden/path-normalization.test.ts") },
  { path: COMMENT_TEST, content: fixture("hidden/comment.test.ts") },
];
const REFERENCE_PATCH = fixture("solution/ops.patch");

// ---- shell helpers ----

function shq(text: string): string {
  return `'${text.split("'").join(`'\\''`)}'`;
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Shell that writes `content` to `path` byte for byte, creating parent dirs. */
function writeFileCmd(path: string, content: string): string {
  const dir = path.slice(0, path.lastIndexOf("/"));
  return `mkdir -p ${shq(dir)} && printf %s ${shq(b64(content))} | base64 -d > ${shq(path)}`;
}

/** git as root on a repo another user owns: name the exception on the command line. */
const GIT = "git -c safe.directory='*'";

const INSTALL_LOG = "/tmp/agent-fs-install.log";
const INSTALL_EXIT = "/tmp/agent-fs-install.exit";

/** Starts `bun install` detached in `dir`; `waitForInstall` polls for it. Each sandbox exec is capped at 60 s. */
function startInstall(dir: string, flags: string): string {
  return [
    `rm -f ${INSTALL_EXIT}`,
    `cd ${shq(dir)}`,
    `nohup sh -c '${BUN} install ${flags} --no-progress > ${INSTALL_LOG} 2>&1; echo $? > ${INSTALL_EXIT}' >/dev/null 2>&1 &`,
  ].join("\n");
}

/** Waits up to ~50 s for the detached install. Exit 0 when done and green, 2 while still running, 1 when it failed. */
function waitForInstall(): string {
  return [
    "for i in $(seq 1 50); do",
    `  if [ -f ${INSTALL_EXIT} ]; then break; fi`,
    "  sleep 1",
    "done",
    `if [ ! -f ${INSTALL_EXIT} ]; then echo 'install still running'; exit 2; fi`,
    `if [ "$(cat ${INSTALL_EXIT})" != 0 ]; then tail -20 ${INSTALL_LOG}; exit 1; fi`,
  ].join("\n");
}

function seedCommands(): string[] {
  const identity = `GIT_AUTHOR_NAME='Eval Maintainer' GIT_AUTHOR_EMAIL='maintainer@example.test' GIT_COMMITTER_NAME='Eval Maintainer' GIT_COMMITTER_EMAIL='maintainer@example.test' GIT_AUTHOR_DATE='${SEED_DATE}' GIT_COMMITTER_DATE='${SEED_DATE}'`;
  // The install and the tarball are the only network the seed needs. The tarball
  // is the parent commit's `git archive`, so it holds no history that could name the fix.
  const tarball = `https://codeload.github.com/${UPSTREAM}/tar.gz/${PARENT_SHA}`;
  const waits = [waitForInstall(), waitForInstall(), waitForInstall()];
  return [
    [
      "set -e",
      `rm -rf ${shq(REPO)} ${shq(REMOTE)}`,
      `mkdir -p ${shq(REPO)} ${shq(REMOTE)}`,
      `curl -fsSL --retry 4 --retry-delay 2 --max-time 45 ${shq(tarball)} | tar -xz --strip-components=1 -C ${shq(REPO)}`,
      `cd ${shq(REPO)}`,
      "git init -q -b main",
      "git config user.name 'Swarm Agent'",
      "git config user.email 'agent@example.test'",
      "git add -A",
      `env ${identity} git commit -q -m 'Import agent-fs at the pinned commit'`,
      `test "$(git rev-parse HEAD)" = ${shq(SEED_SHA)} || { echo "seed commit $(git rev-parse HEAD) is not the pinned ${SEED_SHA}"; exit 1; }`,
      `git init -q --bare -b main ${shq(REMOTE)}`,
      `git remote add origin ${shq(REMOTE)}`,
      "git push -q origin main",
      "git branch -q --set-upstream-to=origin/main main",
    ].join("\n"),
    startInstall(REPO, "--frozen-lockfile"),
    ...waits,
    // The agent may run as a different user than the seeding root: hand it both trees.
    [
      `OWNER=$(stat -c %U:%G /workspace 2>/dev/null || true)`,
      `if [ -n "$OWNER" ]; then chown -R "$OWNER" ${shq(REPO)} ${shq(REMOTE)} || true; fi`,
      `chmod -R a+rwX ${shq(REPO)} ${shq(REMOTE)} || true`,
    ].join("\n"),
  ];
}

// ---- the task: the issue, then how to deliver ----

const ISSUE = [
  "Issue: stat, log and diff cannot find a file I just wrote: `docs/a.md` vs `/docs/a.md`",
  "",
  "Reproduction, any drive:",
  "",
  '    agent-fs write docs/a.md --content "hello"',
  "    agent-fs stat /docs/a.md                   # not found",
  "    agent-fs log /docs/a.md                    # no versions",
  '    agent-fs write /docs/a.md --content "hi"   # a second file with its own history',
  "",
  "The HTTP raw route and the web UI always send paths with a leading slash. The CLI examples and",
  "agents send them without. The ops in packages/core/src/ops (dispatched with `dispatchOp`) use the",
  "path exactly as received, so one file ends up addressed two ways, with two histories.",
  "",
  "Expected: `docs/a.md` and `/docs/a.md` are the same file in every op, with one history. The",
  "leading-slash form is the canonical one.",
  "",
  "From the maintainers:",
  "",
  "- Rows already stored under bare paths in existing drives are a separate migration. Not part of",
  "  this issue.",
  "- Keep the existing tests green. A test that only pins the old behavior should be updated to the",
  "  new rule, and the new behavior needs tests.",
].join("\n");

const DELIVERY = [
  `The repo is at ${REPO}: a bun monorepo, already installed (\`bun test packages/core/src\` runs the`,
  "core tests). Its git remote `origin` is a bare repo on this machine. Work on a new branch,",
  "commit, and `git push origin <branch>`.",
  "",
  "Only what is pushed counts. The maintainers check out the pushed branch on a clean machine and",
  "run their own regression tests against it; you do not have those tests. Finish with a short",
  "note via store-progress naming the branch and what you changed.",
].join("\n");

// ---- hidden test groups ----

interface HiddenGroup {
  name: string;
  /** Names of the hidden tests of one family of ops. */
  tests: string[];
  /**
   * "fix": tests that fail on the parent commit. "keep": tests that already pass there and
   * guard behavior the issue never mentions, so a careless fix can break them. A "keep"
   * group earns credit only when the branch changed op source: doing nothing is not a fix.
   */
  kind: "fix" | "keep";
}

const GROUPS: HiddenGroup[] = [
  {
    name: "write-ops",
    kind: "fix",
    tests: [
      "write uses one database row for bare and slash paths",
      "writeRaw uses one database row for bare and slash paths",
    ],
  },
  {
    name: "read-ops",
    kind: "fix",
    tests: [
      "stat resolves bare and slash paths to the same stored row",
      "log resolves bare and slash paths to the same stored row",
      "diff resolves bare and slash paths to the same stored row",
    ],
  },
  {
    name: "history-ops",
    kind: "fix",
    tests: [
      "append writes both path forms to one history",
      "edit writes both path forms to one history",
      "rm writes both path forms to one history",
      "revert writes both path forms to one history",
    ],
  },
  {
    name: "move-copy",
    kind: "fix",
    tests: [
      "mv normalizes both source and destination before database writes",
      "mv rejects normalized self moves without deleting the source",
      "cp normalizes both source and destination into one destination row",
    ],
  },
  {
    name: "comments",
    kind: "fix",
    tests: [
      "comment-add stores both path forms canonically",
      "comment-list resolves bare and slash exact paths to the same rows",
      "captures the current file version for both path forms",
    ],
  },
  {
    name: "prefix-ops",
    kind: "fix",
    tests: [
      "fts adds a leading slash without changing prefix semantics",
      "recent adds a leading slash without changing prefix semantics",
      "reindex normalizes a bare directory prefix without changing prefix scope",
    ],
  },
  {
    name: "prior-behavior-kept",
    kind: "keep",
    tests: [
      "cat resolves bare and slash paths to the same stored row",
      "tail resolves bare and slash paths to the same stored row",
      "signed-url resolves bare and slash paths to the same stored row",
      "reveal resolves bare and slash paths to the same stored row",
      "share-create stores both path forms canonically",
      "share-revoke resolves both path forms to canonical share rows",
      "ls resolves bare and slash directory prefixes identically",
      "tree resolves bare and slash directory prefixes identically",
      "glob resolves bare and slash directory prefixes identically",
      "grep resolves bare and slash directory prefixes identically",
      "fts keeps a trailing slash and excludes sibling prefixes",
      "recent keeps a trailing slash and excludes sibling prefixes",
      "comment-list keeps its dual-form prefix range and returns canonical rows",
      "search returns a non-empty canonical result",
      "cp rejects normalized self copies without changing the source",
      "every registered top-level path, from, or to parameter has normalization coverage",
    ],
  },
];

const FIX_TEST_COUNT = GROUPS.filter((g) => g.kind === "fix").reduce(
  (n, g) => n + g.tests.length,
  0,
);
const HIDDEN_FILE_PATHS = new Set(HIDDEN_FILES.map((f) => f.path));

// ---- reading bun's junit report ----

export interface TestOutcome {
  status: "P" | "F" | "S";
  file: string;
  name: string;
}

/**
 * Runs in the sandbox (bun) and prints one `status<TAB>file<TAB>name` line per testcase of a
 * junit report, so the grader reads a few KB instead of the report with its failure traces.
 */
const JUNIT_COMPACT_JS = `
const xml = require("fs").readFileSync(process.argv[2], "utf8");
const dec = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, " ").replace(/&amp;/g, "&");
for (const part of xml.split("<testcase ").slice(1)) {
  const end = part.indexOf(">");
  const head = part.slice(0, end);
  const body = head.endsWith("/") ? "" : part;
  const name = /name="([^"]*)"/.exec(head);
  const file = /file="([^"]*)"/.exec(head);
  const status = /<failure|<error/.test(body) ? "F" : /<skipped/.test(body) ? "S" : "P";
  console.log(status + "\\t" + (file ? dec(file[1]) : "") + "\\t" + (name ? dec(name[1]) : ""));
}
`;
const COMPACT_PATH = "/tmp/junit-compact.js";

export function parseOutcomes(stdout: string): TestOutcome[] {
  const out: TestOutcome[] = [];
  for (const line of stdout.split("\n")) {
    const [status, file, ...name] = line.split("\t");
    if ((status === "P" || status === "F" || status === "S") && file !== undefined) {
      out.push({ status, file, name: name.join("\t") });
    }
  }
  return out;
}

function testRunCommand(files: string, reportPath: string): string {
  return [
    `cd ${shq(GRADE_DIR)}`,
    `rm -f ${shq(reportPath)}`,
    `timeout 55 ${BUN} test ${files} --reporter=junit --reporter-outfile=${shq(reportPath)} >/tmp/grade-agent-fs.log 2>&1 || true`,
    `if [ -f ${shq(reportPath)} ]; then ${BUN} ${COMPACT_PATH} ${shq(reportPath)}; else echo "no junit report"; tail -5 /tmp/grade-agent-fs.log; exit 3; fi`,
  ].join("\n");
}

// ---- grading the pushed ref ----

interface GroupResult {
  name: string;
  kind: HiddenGroup["kind"];
  passed: number;
  total: number;
  red: string[];
}

interface GradedClone {
  /** The branch the grader picked, or null when nothing new reached the remote. */
  ref: string | null;
  tip: string | null;
  note: string;
  /** Files under packages/core/src/ops the branch changed, excluding tests. */
  opsFilesChanged: number;
  groups: GroupResult[];
  /** The rest of the core suite (hidden files excluded): how many tests pass, out of how many. */
  regression: { passed: number; total: number; detail: string };
}

const cloneCache = new WeakMap<JudgeContext, Promise<GradedClone>>();

function scoreGroups(outcomes: TestOutcome[]): GroupResult[] {
  const hidden = outcomes.filter((o) => HIDDEN_FILE_PATHS.has(o.file));
  return GROUPS.map((g) => {
    const red: string[] = [];
    let passed = 0;
    for (const name of g.tests) {
      const hit = hidden.find((o) => o.name === name);
      if (hit?.status === "P") passed += 1;
      else red.push(name.split(" ")[0] ?? name);
    }
    return { name: g.name, kind: g.kind, passed, total: g.tests.length, red };
  });
}

function scoreRegression(coreRun: TestOutcome[]): GradedClone["regression"] {
  // The hidden files are graded by their groups; every other file in the core suite must stay green.
  const counted = coreRun.filter((o) => !HIDDEN_FILE_PATHS.has(o.file) && o.status !== "S");
  const failed = counted.filter((o) => o.status === "F");
  const sample = failed
    .slice(0, 3)
    .map((o) => `${o.file.split("/").pop()}: ${o.name.slice(0, 60)}`)
    .join("; ");
  return {
    passed: counted.length - failed.length,
    total: counted.length,
    detail: failed.length ? `${failed.length} red, e.g. ${sample}` : `${counted.length} green`,
  };
}

async function gradeClone(ctx: JudgeContext): Promise<GradedClone> {
  const worker = ctx.workers[0];
  const emptyRegression = { passed: 0, total: 0, detail: "nothing graded" };
  const empty = (note: string): GradedClone => ({
    ref: null,
    tip: null,
    note,
    opsFilesChanged: 0,
    groups: GROUPS.map((g) => ({
      name: g.name,
      kind: g.kind,
      passed: 0,
      total: g.tests.length,
      red: g.tests,
    })),
    regression: emptyRegression,
  });
  if (!worker) return empty("worker 0 not booted");
  const run = (cmd: string) => worker.exec(cmd);

  const refs = await run(
    `${GIT} --git-dir=${shq(REMOTE)} for-each-ref --sort=-committerdate --format='%(refname:short) %(objectname)' refs/heads`,
  );
  const candidates = refs.stdout
    .split("\n")
    .map((line) => line.trim().split(" "))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[1] !== SEED_SHA);
  const pick = candidates[0];
  if (refs.exitCode !== 0 || !pick) {
    const local = await run(
      `${GIT} -C ${shq(REPO)} status --porcelain 2>/dev/null | head -5; ${GIT} -C ${shq(REPO)} log --oneline origin/main..HEAD 2>/dev/null | head -5`,
    ).catch(() => null);
    const hint = local?.stdout.trim()
      ? ` (unpushed work in the working tree: ${local.stdout.trim().replace(/\s+/g, " ").slice(0, 120)})`
      : "";
    return empty(`no branch other than the seed commit reached the remote${hint}`);
  }
  const [ref, tip] = pick;
  const base = { ...empty(""), ref, tip };

  const clone = await run(
    `rm -rf ${shq(GRADE_DIR)} && ${GIT} clone -q --no-tags --branch ${shq(ref)} ${shq(REMOTE)} ${shq(GRADE_DIR)}`,
  );
  if (clone.exitCode !== 0) {
    return { ...base, note: `clone of ${ref} failed: ${clone.stderr.slice(0, 160)}` };
  }

  const changed = await run(
    `${GIT} -C ${shq(GRADE_DIR)} diff --name-only ${SEED_SHA} HEAD -- packages/core/src/ops | grep -v '__tests__' | wc -l`,
  );
  const opsFilesChanged = Number(changed.stdout.trim()) || 0;

  // The hidden tests overwrite the agent's copies, and a bunfig the agent pushed cannot steer the run.
  const prepare = await run(
    [
      `cd ${shq(GRADE_DIR)}`,
      `${GIT} checkout -q ${SEED_SHA} -- bunfig.toml`,
      ...HIDDEN_FILES.map((f) => writeFileCmd(`${GRADE_DIR}/${f.path}`, f.content)),
      `printf %s ${shq(b64(JUNIT_COMPACT_JS))} | base64 -d > ${COMPACT_PATH}`,
      startInstall(GRADE_DIR, "--frozen-lockfile"),
    ].join("\n"),
  );
  if (prepare.exitCode !== 0) {
    return {
      ...base,
      opsFilesChanged,
      note: `could not prepare the clone: ${prepare.stderr.slice(0, 160)}`,
    };
  }
  let installed = false;
  let installNote = "";
  for (let i = 0; i < 4 && !installed; i++) {
    const res = await run(waitForInstall());
    installed = res.exitCode === 0;
    installNote = `${res.stdout} ${res.stderr}`.trim().slice(-200);
    if (res.exitCode === 1 && i === 0) {
      // A frozen install fails when the agent touched package.json or the lockfile: retry unfrozen once.
      await run(startInstall(GRADE_DIR, ""));
    } else if (res.exitCode === 1) break;
  }
  if (!installed) {
    return { ...base, opsFilesChanged, note: `bun install on the clone failed: ${installNote}` };
  }

  const hiddenRun = await run(
    testRunCommand(HIDDEN_FILES.map((f) => shq(f.path)).join(" "), "/tmp/grade-hidden.xml"),
  );
  const hiddenOutcomes = hiddenRun.exitCode === 0 ? parseOutcomes(hiddenRun.stdout) : [];
  if (hiddenOutcomes.length === 0) {
    return {
      ...base,
      opsFilesChanged,
      note: `hidden tests produced no report on ${ref} (${`${hiddenRun.stdout} ${hiddenRun.stderr}`.trim().slice(-160)})`,
    };
  }

  const coreRun = await run(testRunCommand("packages/core/src", "/tmp/grade-core.xml"));
  const coreOutcomes = coreRun.exitCode === 0 ? parseOutcomes(coreRun.stdout) : [];
  const regression = coreOutcomes.length
    ? scoreRegression(coreOutcomes)
    : { passed: 0, total: 0, detail: "the core suite produced no report (timed out or crashed)" };

  const finalGroups = scoreGroups(hiddenOutcomes);
  return {
    ref,
    tip,
    note: `graded ${ref} @ ${tip.slice(0, 8)}`,
    opsFilesChanged,
    groups: finalGroups,
    regression,
  };
}

function graded(ctx: JudgeContext): Promise<GradedClone> {
  let hit = cloneCache.get(ctx);
  if (!hit) {
    hit = gradeClone(ctx);
    cloneCache.set(ctx, hit);
  }
  return hit;
}

/**
 * One graded check per group, so a run's correctness reads as seven numbers. A group is a
 * family of ops: it scores 1 when every test in it is green and 0 otherwise, the way a
 * maintainer would review it (a family half normalized is not done).
 */
function groupCheck(name: string): DeterministicCheck {
  return {
    name: `hidden-${name}`,
    fn: async (ctx): Promise<CheckResult> => {
      const g = await graded(ctx);
      const hit = g.groups.find((x) => x.name === name);
      if (!hit) return { pass: false, score: 0, detail: `no group ${name}` };
      if (g.ref === null) return { pass: false, score: 0, detail: g.note };
      const green = hit.passed === hit.total;
      if (green && hit.kind === "keep" && g.opsFilesChanged === 0) {
        return {
          pass: false,
          score: 0,
          detail: `${g.note}: ${hit.passed}/${hit.total} green, but no op source changed, so keeping behavior earns nothing`,
        };
      }
      return {
        pass: green,
        score: green ? 1 : 0,
        detail: green
          ? `${g.note}: ${hit.passed}/${hit.total} green`
          : `${g.note}: ${hit.passed}/${hit.total} green (red: ${hit.red.join(", ")})`,
      };
    },
  };
}

const hiddenGroupChecks = GROUPS.map((g) => groupCheck(g.name));

const pushedBranch: DeterministicCheck = {
  name: "pushed-branch",
  fn: async (ctx): Promise<CheckResult> => {
    const g = await graded(ctx);
    if (g.ref === null) return { pass: false, score: 0, detail: g.note };
    return {
      pass: true,
      score: 1,
      detail: `${g.note}; ${g.opsFilesChanged} op file(s) changed`,
    };
  },
};

const noRegressions: DeterministicCheck = {
  name: "existing-tests-still-green",
  fn: async (ctx): Promise<CheckResult> => {
    const g = await graded(ctx);
    if (g.ref === null) return { pass: false, score: 0, detail: g.note };
    const { passed, total, detail } = g.regression;
    if (total === 0) return { pass: false, score: 0, detail };
    return {
      pass: passed === total,
      score: clamp01(passed / total),
      detail: `${passed}/${total}: ${detail}`,
    };
  },
};

// The fix is public (our own repo, and the npm package). Someone who fetches it is not solving
// the issue. A run never needs GitHub: the repo is local, and so are its tests. The workspace
// packages are named `@desplega.ai/agent-fs-*` in node_modules, which is why the npm form only
// matches the published CLI (`@desplega.ai/agent-fs` followed by a version, space or end).
const UPSTREAM_RE = new RegExp(
  [
    "github\\.com/desplega-ai/agent-fs",
    "codeload\\.github\\.com",
    "raw\\.githubusercontent\\.com/desplega-ai",
    "api\\.github\\.com/repos/desplega-ai",
    "\\bgh\\s+(?:pr|api|repo|search|browse|issue)\\b[^\\n]*agent-fs",
    "\\b(?:npm|npx|bunx|pnpm|yarn)\\s[^\\n]*@desplega\\.ai/agent-fs(?![-\\w/])",
  ].join("|"),
  "i",
);
const WEB_TOOL_RE = /^(?:WebFetch|WebSearch|web_search|web_fetch)$/i;

export function upstreamLookup(tools: { toolName: string; input: unknown }[]): string | null {
  for (const use of tools) {
    const input = safeStringify(use.input);
    if (UPSTREAM_RE.test(input)) return `${use.toolName}: ${input.slice(0, 120)}`;
    if (WEB_TOOL_RE.test(use.toolName) && /agent-fs|desplega/i.test(input)) {
      return `${use.toolName}: ${input.slice(0, 120)}`;
    }
  }
  return null;
}

const noUpstreamLookup: DeterministicCheck = {
  name: "no-upstream-lookup",
  fn: async (ctx): Promise<CheckResult> => {
    const worker = ctx.workers[0];
    const task = ctx.tasks.find((t) => t.agentId === worker?.agentId) ?? ctx.tasks[0];
    const hit = upstreamLookup(await taskToolUses(ctx, task));
    return hit
      ? { pass: false, detail: `looked up the real fix: ${hit}` }
      : { pass: true, detail: "no GitHub or upstream package lookup in the session" };
  },
};

export const realDiffAgentFs: Scenario = {
  id: "real-diff-agent-fs",
  version: 1,
  name: "Real diff: agent-fs path normalization",
  description: [
    "Ships a real merged fix (desplega-ai/agent-fs PR #73) as a task: the whole repo at the fix's",
    "parent commit, installed, the issue text, and a bare remote. The agent commits on a branch and",
    "pushes. The grader clones the pushed ref fresh, overlays the fix's own hidden tests and runs",
    "them: seven groups, each 1 when all its tests are green (six families of ops over the 18",
    "tests that fail on the parent, plus 16 that must keep passing; correctness, 8×), a new commit",
    "on the remote with the rest of the core suite still green (delivery, 1×), and cost and time",
    "against budget (1×).",
  ].join(" "),
  seed: { exec: seedCommands() },
  tasks: [
    {
      title: "Fix: file ops treat docs/a.md and /docs/a.md as different files",
      description: `${ISSUE}\n\n${DELIVERY}`,
    },
  ],
  outcome: {
    // Nothing pushed, or a fix fetched from upstream: not a pass, whatever the score.
    gates: [pushedBranch, noUpstreamLookup],
    dimensions: [
      { name: "correctness", weight: 8, checks: hiddenGroupChecks },
      { name: "delivery", weight: 1, checks: [pushedBranch, noRegressions] },
      { name: "efficiency", weight: 1 },
    ],
  },
  budgetUsd: 5,
  budgetMs: 20 * 60_000,
  timeoutMs: 30 * 60_000,
};

export const __test__ = {
  REPO,
  REMOTE,
  GRADE_DIR,
  PARENT_SHA,
  SEED_SHA,
  SEED_DATE,
  HIDDEN_FILES,
  PATH_TEST,
  COMMENT_TEST,
  REFERENCE_PATCH,
  GROUPS,
  FIX_TEST_COUNT,
  ISSUE,
  DELIVERY,
  seedCommands,
  JUNIT_COMPACT_JS,
  testRunCommand,
  scoreGroups,
  scoreRegression,
  writeFileCmd,
};
