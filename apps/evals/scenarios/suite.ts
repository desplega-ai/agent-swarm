/**
 * Suite manifest: which scenario versions make up `swarm-evals@<version>`.
 *
 * An attempt records `suite_version` only when its scenario, at the version it
 * ran, is listed here. A run of a scenario outside the manifest, or at a
 * different scenario version, records NULL and never mixes into a suite chart.
 *
 * Versioning rules (docs: scenarios/CHANGELOG.md):
 *   - scenario `version`: bump on any prompt, fixture or check change.
 *   - suite MINOR: a fix to a check or fixture that changes scores (all configs rerun).
 *   - suite MAJOR: scenarios added or dropped.
 *
 * 1.0 is the suite Phase 10 publishes. It stays open until then, so Phases 7-8
 * add their scenarios here before publication without a MAJOR bump.
 */

export const SUITE_ID = "swarm-evals";
export const SUITE_VERSION = "1.0";

/** Scenario id -> scenario version. Keep in sync with scenarios/index.ts (a test enforces it). */
export const SUITE_SCENARIO_VERSIONS: Readonly<Record<string, number>> = {
  "sql-audit": 1,
  "delegation-probe": 1,
  "workflow-authoring": 1,
  "script-authoring": 1,
  "delegation-chain": 2,
  "tool-routing": 1,
  "fanout-research": 1,
  "fanout-research-solo": 1,
  "worker-recovery": 1,
  "worker-recovery-solo": 1,
};

/** `1.0` when the scenario at that version is in the manifest, else null. */
export function suiteVersionFor(scenarioId: string, scenarioVersion: number): string | null {
  return SUITE_SCENARIO_VERSIONS[scenarioId] === scenarioVersion ? SUITE_VERSION : null;
}
