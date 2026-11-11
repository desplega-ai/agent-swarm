import type { ScenarioResult } from "./report";
import type { Scenario } from "./run";

type Ordered = Pick<Scenario, "name" | "order" | "needs">;

/**
 * What a rerun boots on its fresh API: the failed scenario plus every scenario it declares
 * in `needs`, transitively, in run order. Prerequisites replay only to rebuild state.
 */
export function rerunPlan<T extends Ordered>(failed: T, all: readonly T[]): T[] {
  const byName = new Map(all.map((scenario) => [scenario.name, scenario]));
  const picked = new Map<string, T>();
  const visit = (scenario: T) => {
    if (picked.has(scenario.name)) return;
    picked.set(scenario.name, scenario);
    for (const name of scenario.needs ?? []) {
      const needed = byName.get(name);
      if (!needed) throw new Error(`${scenario.name} needs unknown scenario ${name}`);
      visit(needed);
    }
  };
  visit(failed);
  return [...picked.values()].sort((a, b) => a.order - b.order);
}

/**
 * One result row per scenario, whatever the attempt count. A pass on the rerun is `flaky`
 * and keeps the first attempt's error; anything else on the rerun (fail, skip) stays `fail`
 * with the rerun's error. A rerun that could not boot or replay its prerequisites decides nothing, so the
 * scenario keeps its first failure.
 */
export function settleRerun(
  first: ScenarioResult,
  rerun: ScenarioResult | { error: string },
): ScenarioResult {
  if (!("status" in rerun)) {
    return {
      ...first,
      attempts: [attempt(first), { status: "fail", durationMs: 0, error: rerun.error }],
      error: `${first.error ?? "failed"}; rerun did not run: ${rerun.error}`,
    };
  }
  const attempts = [attempt(first), attempt(rerun)];
  const durationMs = first.durationMs + rerun.durationMs;
  if (rerun.status === "pass") {
    return { ...first, status: "flaky", durationMs, attempts };
  }
  return { ...first, status: "fail", durationMs, error: rerun.error, attempts };
}

function attempt(result: ScenarioResult) {
  return { status: result.status, durationMs: result.durationMs, error: result.error };
}
