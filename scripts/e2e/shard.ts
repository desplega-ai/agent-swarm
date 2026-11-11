import type { CoverageInputs, CoverageManifest, CoverageUniverse } from "./coverage";
import type { HttpCall } from "./http";
import type { ScenarioResult } from "./report";

/**
 * Fixed shard bands by scenario `order`, not by timing: shard 1 runs order < 130, shard 2
 * runs 130 up to 140, shard 3 runs 140 on. The cuts follow the Slack renderer flags, which
 * scenarios flip for the rest of a process: SLACK_RENDER_V2 turns on at 130
 * (slack-delegation-flag-off-repro asserts delegation is still off) and
 * SLACK_RENDER_V2_DELEGATION at 140 (slack-delegation-child-result). Moving a cut means
 * checking that no band starts in a flag state its first scenario does not set itself.
 */
export const SHARD_CUTS: readonly number[] = [130, 140];
export const SHARD_COUNT = SHARD_CUTS.length + 1;

export type Shard = { index: number; total: number };

/** `--shard i/n`. Only n = SHARD_COUNT is valid: the bands are fixed. */
export function parseShard(value: string): Shard {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (!match || total !== SHARD_COUNT || index < 1 || index > total) {
    throw new Error(`--shard must be i/${SHARD_COUNT} with i from 1 through ${SHARD_COUNT}`);
  }
  return { index, total };
}

/** 1-based band a scenario order falls in. */
export function bandOf(order: number): number {
  return SHARD_CUTS.filter((cut) => order >= cut).length + 1;
}

/**
 * A scenario's `needs` replay on its rerun, so they must sit in its band: another shard's
 * process never ran them. Returns one line per crossing, empty when the bands hold.
 */
export function bandProblems(
  scenarios: ReadonlyArray<{ name: string; order: number; needs?: string[] }>,
): string[] {
  const orders = new Map(scenarios.map((scenario) => [scenario.name, scenario.order]));
  const problems: string[] = [];
  for (const scenario of scenarios) {
    for (const name of scenario.needs ?? []) {
      const order = orders.get(name);
      if (order !== undefined && bandOf(order) !== bandOf(scenario.order)) {
        problems.push(
          `${scenario.name} (shard ${bandOf(scenario.order)}) needs ${name} (shard ${bandOf(order)}): move a cut in SHARD_CUTS`,
        );
      }
    }
  }
  return problems;
}

/**
 * Everything coverage is computed from, as plain data. A shard writes its own into its
 * JSON result; the merge job unions them and computes coverage once, on the union.
 */
export type Observations = {
  universe: CoverageUniverse;
  /** Every scenario the registry knows, selected or not. */
  knownScenarios: string[];
  calls: HttpCall[];
  toolUniverse: string[];
  calledTools: string[];
  nodeTypes: string[];
  /** CLI commands the shard's scenarios ran. */
  calledCommands: string[];
  /** Manifest state-surface query to the distinct values the database held. */
  stateValues: Record<string, string[]>;
};

const union = (lists: string[][]) => [...new Set(lists.flat())].sort();

/** Union of the shards' observations. Shards of one commit expose one universe. */
export function mergeObservations(parts: readonly Observations[]): Observations {
  const [first, ...rest] = parts;
  if (!first) throw new Error("No shard observations to merge");
  const same = (pick: (part: Observations) => unknown) =>
    rest.every((part) => JSON.stringify(pick(part)) === JSON.stringify(pick(first)));
  if (!same((part) => part.universe) || !same((part) => [...part.knownScenarios].sort())) {
    throw new Error("Shards disagree on the server universe or the scenario registry");
  }
  const queries = union(parts.map((part) => Object.keys(part.stateValues)));
  return {
    universe: first.universe,
    knownScenarios: first.knownScenarios,
    calls: parts.flatMap((part) => part.calls),
    toolUniverse: union(parts.map((part) => part.toolUniverse)),
    calledTools: union(parts.map((part) => part.calledTools)),
    nodeTypes: union(parts.map((part) => part.nodeTypes)),
    calledCommands: union(parts.map((part) => part.calledCommands ?? [])),
    stateValues: Object.fromEntries(
      queries.map((query) => [query, union(parts.map((part) => part.stateValues[query] ?? []))]),
    ),
  };
}

export function coverageInputs(
  observations: Observations,
  scenarios: readonly ScenarioResult[],
  manifest: CoverageManifest,
): CoverageInputs {
  return {
    calls: observations.calls,
    toolUniverse: new Set(observations.toolUniverse),
    calledTools: new Set(observations.calledTools),
    observedNodeTypes: new Set(observations.nodeTypes),
    calledCommands: new Set(observations.calledCommands ?? []),
    scenarios,
    knownScenarios: new Set(observations.knownScenarios),
    queryValues: (sql) => observations.stateValues[sql] ?? [],
    manifest,
  };
}
