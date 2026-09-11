import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Scenario } from "../run";

// Runtime directory scan + dynamic import, not a hardcoded list. This runner always executes
// from source (`bun scripts/e2e/run.ts`), unlike the API server which ships as a compiled
// binary and needs static imports (see the seeded-skills note in CLAUDE.md) — so a scan here
// is safe. Dropping a new `scripts/e2e/scenarios/<name>.ts` file that exports a `Scenario` is
// enough; nothing else needs editing to make the runner see it.
const SCENARIOS_DIR = join(import.meta.dir);

// Files in this directory that are shared helpers, not scenarios themselves. A file NOT listed
// here that exports zero Scenario objects is a mistake (typo'd export shape, forgotten export,
// wrong `order`/`run` types) and loadScenarios() throws — this is the "did I actually get wired
// in" check, and it runs on every invocation, not just in CI.
const NON_SCENARIO_FILES = new Set(["registry.ts", "slack-helpers.ts"]);

function isScenario(value: unknown): value is Scenario {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Scenario).name === "string" &&
    typeof (value as Scenario).order === "number" &&
    typeof (value as Scenario).run === "function"
  );
}

/**
 * Discovers every Scenario exported anywhere under scripts/e2e/scenarios/, sorted by each
 * scenario's declared `order`. Order is a first-class field on the Scenario itself (not
 * filesystem/import order) because several scenarios carry cross-scenario state that must run
 * in a specific sequence — see the ordering comments in slack-delegation-flag-off-repro.ts and
 * slack-delegation-child-result.ts.
 */
export async function loadScenarios(): Promise<Scenario[]> {
  const files = (await readdir(SCENARIOS_DIR))
    .filter((file) => file.endsWith(".ts") && !NON_SCENARIO_FILES.has(file))
    .sort();

  const scenarios: Scenario[] = [];
  const nameOwners = new Map<string, string>();
  const orderOwners = new Map<number, string>();

  for (const file of files) {
    const module = (await import(join(SCENARIOS_DIR, file))) as Record<string, unknown>;
    const found = Object.values(module).filter(isScenario);
    if (found.length === 0) {
      throw new Error(
        `${file} exports no Scenario. If it's a shared helper module, add it to ` +
          `NON_SCENARIO_FILES in scripts/e2e/scenarios/registry.ts instead.`,
      );
    }
    for (const scenario of found) {
      const nameOwner = nameOwners.get(scenario.name);
      if (nameOwner) {
        throw new Error(`Duplicate scenario name "${scenario.name}" in ${file} and ${nameOwner}`);
      }
      nameOwners.set(scenario.name, file);

      const orderOwner = orderOwners.get(scenario.order);
      if (orderOwner) {
        throw new Error(
          `Duplicate scenario order ${scenario.order}: "${scenario.name}" (${file}) collides ` +
            `with "${orderOwner}"`,
        );
      }
      orderOwners.set(scenario.order, scenario.name);

      scenarios.push(scenario);
    }
  }

  return scenarios.sort((a, b) => a.order - b.order);
}
