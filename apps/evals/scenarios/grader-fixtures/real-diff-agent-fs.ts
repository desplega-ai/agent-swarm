import type { JudgeContext, SwarmTask } from "../../src/types.ts";
import { type GraderFixture, makeContext, nullTasks } from "../grader-validation-support.ts";
import { __test__ as key, realDiffAgentFs } from "../real-diff-agent-fs.ts";

/**
 * The grader here clones a branch, installs a 1.5 GB monorepo and runs its test suite, which
 * CI must not do. So this fixture stands in for worker 0's shell: it recognizes each command
 * the grader issues and answers like the sandbox would, from a table of which hidden tests
 * are green. Everything after the shell (parsing the junit summary, grouping, scoring, the
 * keep-group rule, the gates) is the real grader code.
 *
 * The commands themselves are exercised for real by `scripts/validate-real-diff-agent-fs.ts`
 * (network, bun install), which pushes the real fix and a no-op branch through the real seed
 * and grader. Run it after any change to the seed or the grading commands.
 *
 * Reference: the real fix pushed on a branch, every hidden test green, the core suite green.
 * Null agent: nothing pushed.
 */

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SimulatedBranch {
  name: string;
  /** Op source files the branch changed (the `diff --name-only | wc -l` the grader reads). */
  opsFilesChanged: number;
  /** Hidden-test names that are red on it. Everything else in the hidden files is green. */
  red?: string[];
  /** Tests in the rest of the core suite that are red on it. */
  redCoreTests?: number;
  /** `bun install` exit code on the clone (0 = ok). */
  installExit?: number;
  /** When true the hidden run writes no junit report (a hang or crash). */
  noHiddenReport?: boolean;
  /** When true the full core run writes no junit report. */
  noCoreReport?: boolean;
}

const TIP = "0123456789abcdef0123456789abcdef01234567";

/** Every test the hidden files hold that the grader names, with the file it lives in. */
function hiddenTests(): { file: string; name: string }[] {
  return key.GROUPS.flatMap((g) =>
    g.tests.map((name) => ({
      file:
        name === "captures the current file version for both path forms"
          ? key.COMMENT_TEST
          : key.PATH_TEST,
      name,
    })),
  );
}

function compact(lines: { status: "P" | "F" | "S"; file: string; name: string }[]): string {
  return `${lines.map((l) => `${l.status}\t${l.file}\t${l.name}`).join("\n")}\n`;
}

export class SimulatedSandbox {
  constructor(private readonly branch: SimulatedBranch | null) {}

  async exec(cmd: string): Promise<ExecResult> {
    const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
    const b = this.branch;
    if (cmd.includes("for-each-ref")) {
      return ok(b ? `${b.name} ${TIP}\nmain ${key.SEED_SHA}\n` : `main ${key.SEED_SHA}\n`);
    }
    if (!b) return ok("");
    if (cmd.includes("clone -q")) return ok();
    if (cmd.includes("diff --name-only")) return ok(`${b.opsFilesChanged}\n`);
    if (cmd.includes("install still running")) {
      return b.installExit ? { exitCode: 1, stdout: "error: install failed", stderr: "" } : ok();
    }
    if (cmd.includes("grade-hidden.xml")) {
      if (b.noHiddenReport) return { exitCode: 3, stdout: "no junit report\n", stderr: "" };
      const red = new Set(b.red ?? []);
      return ok(
        compact(
          hiddenTests().map((t) => ({
            ...t,
            status: red.has(t.name) ? ("F" as const) : ("P" as const),
          })),
        ),
      );
    }
    if (cmd.includes("grade-core.xml")) {
      if (b.noCoreReport) return { exitCode: 3, stdout: "no junit report\n", stderr: "" };
      const rows = Array.from({ length: 40 }, (_, i) => ({
        status: i < (b.redCoreTests ?? 0) ? ("F" as const) : ("P" as const),
        file: "packages/core/src/ops/__tests__/stat.test.ts",
        name: `stat case ${i}`,
      }));
      // The hidden files show up in the core run too; the grader must not count them twice.
      const dup = hiddenTests().map((t) => ({ ...t, status: "P" as const }));
      return ok(compact([...rows, ...dup]));
    }
    // checkout, file writes, the detached install start
    return ok();
  }
}

function contextFor(branch: SimulatedBranch | null): JudgeContext {
  const sandbox = new SimulatedSandbox(branch);
  const base = makeContext(realDiffAgentFs, { tasks: nullTasks(realDiffAgentFs) });
  const worker0 = base.workers[0] as JudgeContext["workers"][number];
  const worker = {
    ...worker0,
    exec: (cmd: string) => sandbox.exec(cmd),
    readFile: async () => null,
  };
  return { ...base, workers: [worker], exec: worker.exec, readFile: worker.readFile };
}

/** A judge context whose worker 0 behaves as a sandbox holding `branch` on its remote. */
export function simulatedContext(branch: SimulatedBranch | null): JudgeContext {
  return contextFor(branch);
}

function reference(): JudgeContext {
  const ctx = contextFor({ name: "fix/path-normalization", opsFilesChanged: 18 });
  const done = ctx.tasks.map(
    (t) => ({ ...t, result: "Pushed fix/path-normalization." }) as SwarmTask,
  );
  return { ...ctx, tasks: done };
}

function nullContext(): JudgeContext {
  return contextFor(null);
}

export const fixture: GraderFixture = {
  reference,
  nullContext,
  notes:
    "Simulated sandbox shell (no clone, no install): exercises the grader's parsing, grouping and scoring. scripts/validate-real-diff-agent-fs.ts runs the real thing.",
};
