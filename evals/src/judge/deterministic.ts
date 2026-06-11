import type { CheckResult, DeterministicCheck, JudgeContext } from "../types.ts";

export interface CheckRunResult extends CheckResult {
  name: string;
}

/** Run all deterministic checks; a thrown check counts as a failure, not a crash. */
export async function runChecks(
  checks: DeterministicCheck[],
  ctx: JudgeContext,
): Promise<CheckRunResult[]> {
  const results: CheckRunResult[] = [];
  for (const check of checks) {
    try {
      const res = await check.fn(ctx);
      results.push({ name: check.name, ...res });
    } catch (err) {
      results.push({
        name: check.name,
        pass: false,
        detail: `check threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return results;
}

/** Common check: every scenario task reached a terminal-success status. */
export function allTasksCompleted(): DeterministicCheck {
  return {
    name: "all-tasks-completed",
    fn: async (ctx) => {
      const bad = ctx.tasks.filter((t) => !["done", "completed"].includes(t.status));
      return bad.length === 0
        ? { pass: true }
        : {
            pass: false,
            detail: `tasks not done: ${bad.map((t) => `${t.title}=${t.status}`).join(", ")}`,
          };
    },
  };
}

/** Common check: a file exists in the sandbox and (optionally) matches a pattern. */
export function fileContains(path: string, pattern?: RegExp): DeterministicCheck {
  return {
    name: `file-contains:${path}`,
    fn: async (ctx) => {
      const content = await ctx.readFile(path);
      if (content === null) return { pass: false, detail: `${path} not found` };
      if (pattern && !pattern.test(content)) {
        return { pass: false, detail: `${path} does not match ${pattern}` };
      }
      return { pass: true, detail: `${path} (${content.length} bytes)` };
    },
  };
}
