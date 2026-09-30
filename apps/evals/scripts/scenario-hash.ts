/**
 * Print the current content hash of every registered scenario, ready to paste
 * into scenarios/scenario-hashes.ts.
 *
 *   bun scripts/scenario-hash.ts            # all scenarios
 *   bun scripts/scenario-hash.ts sql-audit  # one scenario
 *
 * Bump the scenario's `version` first, then append the printed `{ version, hash }`
 * to that scenario's history array. Never edit or delete an old entry.
 */

import { scenarios } from "../scenarios/index.ts";
import { hashScenario } from "../src/scenario-hash.ts";

const wanted = new Set(process.argv.slice(2));
for (const scenario of scenarios) {
  if (wanted.size > 0 && !wanted.has(scenario.id)) continue;
  console.log(
    `"${scenario.id}": { version: ${scenario.version}, hash: "${hashScenario(scenario)}" }`,
  );
}
