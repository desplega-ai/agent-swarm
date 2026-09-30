/**
 * Content hash of a scenario, used to fail a test when a prompt, fixture or
 * check changes without a `version` bump (see scenarios/versioning.test.ts).
 *
 * Three inputs, so no single kind of edit slips through:
 *   1. the scenario object, canonicalized (sorted keys, functions collapsed):
 *      every task prompt, rubric, weight, budget, roster and seed entry;
 *   2. the bytes of every fixture it references (sqlDump, script sourceFile);
 *   3. the scenario's own source file as a TypeScript token stream: check
 *      logic and module-level answer keys, with comments and formatting
 *      ignored so a Biome reformat or a doc edit never demands a bump.
 *
 * Not hashed: shared graders (scenarios/orchestration-utils.ts, src/judge/*).
 * A change there that moves scores must bump the scenarios it affects by hand;
 * scenarios/CHANGELOG.md says so.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { Scenario } from "./types.ts";

const SCENARIOS_DIR = join(import.meta.dir, "../scenarios");
const FIXTURES_DIR = join(SCENARIOS_DIR, "fixtures");

/** Keys that describe the scenario to humans; they never reach an agent or a grader. */
const IGNORED_TOP_LEVEL_KEYS = new Set(["version", "name", "description"]);

function canonical(value: unknown): unknown {
  if (typeof value === "function") return "[function]";
  if (value instanceof RegExp) return `[regexp ${String(value)}]`;
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** TypeScript tokens joined by single spaces: comments and layout drop out. */
export function normalizeSourceTokens(text: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ true,
    ts.LanguageVariant.Standard,
    text,
  );
  const tokens: string[] = [];
  for (let t = scanner.scan(); t !== ts.SyntaxKind.EndOfFileToken; t = scanner.scan()) {
    tokens.push(scanner.getTokenText());
  }
  return tokens.join(" ");
}

function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Bare filenames of the fixtures a scenario reads from scenarios/fixtures/. */
export function scenarioFixtureFiles(scenario: Scenario): string[] {
  const files = new Set<string>();
  if (scenario.seed?.sqlDump) files.add(scenario.seed.sqlDump);
  for (const script of scenario.seed?.scripts ?? []) files.add(script.sourceFile);
  return [...files].sort();
}

export interface ScenarioHashInputs {
  definition: unknown;
  fixtures: Record<string, string>;
  source: string;
}

export function scenarioHashInputs(
  scenario: Scenario,
  opts: { scenariosDir?: string } = {},
): ScenarioHashInputs {
  const scenariosDir = opts.scenariosDir ?? SCENARIOS_DIR;
  const fixturesDir = join(scenariosDir, "fixtures");
  const definition = canonical(
    Object.fromEntries(Object.entries(scenario).filter(([k]) => !IGNORED_TOP_LEVEL_KEYS.has(k))),
  );
  const fixtures: Record<string, string> = {};
  for (const name of scenarioFixtureFiles(scenario)) {
    fixtures[name] = sha256(readFileSync(join(fixturesDir, name)));
  }
  // A `-solo` baseline is derived in its swarm scenario's module, so it hashes that source.
  const sourceFile = `${scenario.baselineOf ?? scenario.id}.ts`;
  const source = sha256(
    normalizeSourceTokens(readFileSync(join(scenariosDir, sourceFile), "utf8")),
  );
  return { definition, fixtures, source };
}

/** 16 hex chars of sha256 over the canonical inputs. Pinned per version in scenarios/scenario-hashes.ts. */
export function hashScenario(scenario: Scenario, opts: { scenariosDir?: string } = {}): string {
  return sha256(JSON.stringify(scenarioHashInputs(scenario, opts))).slice(0, 16);
}

export { FIXTURES_DIR, SCENARIOS_DIR };
