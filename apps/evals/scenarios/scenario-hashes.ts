/**
 * Pinned content hash per scenario version (see src/scenario-hash.ts).
 *
 * APPEND-ONLY. When a prompt, fixture or check changes:
 *   1. bump `version` on the scenario,
 *   2. run `bun scripts/scenario-hash.ts <id>`,
 *   3. append the printed `{ version, hash }` to that scenario's array,
 *   4. add a line to scenarios/CHANGELOG.md.
 * scenarios/versioning.test.ts fails when the current content does not match the
 * last entry, when versions do not strictly increase, or when the last entry's
 * version differs from the scenario's `version`. Rewriting an old entry is a review
 * red flag: it hides a scoring change from every published number.
 */

export interface PinnedScenarioHash {
  version: number;
  hash: string;
}

export const SCENARIO_HASHES: Readonly<Record<string, readonly PinnedScenarioHash[]>> = {
  "sql-audit": [{ version: 1, hash: "f51f6c31ea003792" }],
  "delegation-probe": [{ version: 1, hash: "82c25dbb127c8648" }],
  "workflow-authoring": [{ version: 1, hash: "d2be3b80b0044a83" }],
  "script-authoring": [{ version: 1, hash: "862befd7c6f3903c" }],
  "delegation-chain": [
    { version: 1, hash: "6ccb45d0f9bbc3ae" },
    { version: 2, hash: "2a1dc408cb6a731e" },
  ],
  "tool-routing": [{ version: 1, hash: "e41b42bf3bcc1a9a" }],
  "fanout-research": [{ version: 1, hash: "4ad89cd28b49d168" }],
  "fanout-research-solo": [{ version: 1, hash: "d78c739359c4ee4d" }],
  "worker-recovery": [{ version: 1, hash: "fd694b7a337a206d" }],
  "worker-recovery-solo": [{ version: 1, hash: "1c9099583f923431" }],
  "implement-review": [{ version: 1, hash: "cb8b5f8260c133e9" }],
  "implement-review-solo": [{ version: 1, hash: "ab6e075a48cb8f69" }],
  "capability-routing": [{ version: 1, hash: "07161180e8236cb8" }],
  "human-in-loop": [{ version: 1, hash: "70987b1d68b5d91d" }],
  "human-in-loop-solo": [{ version: 1, hash: "c592a3fff01df372" }],
};
