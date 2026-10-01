/**
 * Content hash of a scenario, used to fail a test when a prompt, fixture or
 * check changes without a `version` bump (see scenarios/versioning.test.ts).
 *
 * Three inputs, so no single kind of edit slips through:
 *   1. the scenario object, canonicalized (sorted keys, functions collapsed):
 *      every task prompt, rubric, weight, budget, roster and seed entry;
 *   2. the bytes of every fixture it references (sqlDump, script sourceFile) and
 *      of every file under `scenarios/fixtures/<id>/`, the directory a scenario
 *      keeps grader-only files in (hidden tests, a seeded repo);
 *   3. the scenario's own source file as a TypeScript token stream: check
 *      logic and module-level answer keys, with comments and formatting
 *      ignored so a Biome reformat or a doc edit never demands a bump.
 *
 * Not hashed: shared graders (scenarios/orchestration-utils.ts, src/judge/*).
 * A change there that moves scores must bump the scenarios it affects by hand;
 * scenarios/CHANGELOG.md says so.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { Scenario } from "./types.ts";

const SCENARIOS_DIR = join(import.meta.dir, "../scenarios");
const FIXTURES_DIR = join(SCENARIOS_DIR, "fixtures");

/**
 * Fixtures are small text files (the largest today is ~35 KB). The caps keep a
 * hostile or accidental PR (a huge blob, a symlink to a device) from exhausting
 * the memory of the process that hashes every scenario on each eval test run.
 */
const MAX_FIXTURE_FILE_BYTES = 1024 * 1024;
const MAX_FIXTURE_TOTAL_BYTES = 8 * 1024 * 1024;

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

/**
 * Every regular file under `dir`, as paths relative to `base` (forward slashes).
 * A symlink or any other non-regular entry (device, fifo, socket) throws: a
 * symlink would be followed on read, and a fixture must be bytes in the repo.
 */
function walkFiles(base: string, dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(base, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(base, rel));
    else if (entry.isFile()) out.push(rel);
    else throw new Error(`scenario fixture ${rel} is not a regular file (symlinks are rejected)`);
  }
  return out;
}

/**
 * Read a fixture's bytes, refusing anything but a regular file within the size
 * caps. `budget.remaining` is the aggregate allowance left for the scenario.
 */
function readFixture(path: string, label: string, budget: { remaining: number }): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(`scenario fixture ${label} is not a regular file (symlinks are rejected)`);
  }
  if (stat.size > MAX_FIXTURE_FILE_BYTES) {
    throw new Error(
      `scenario fixture ${label} is ${stat.size} bytes, over the ${MAX_FIXTURE_FILE_BYTES} byte per-file limit`,
    );
  }
  budget.remaining -= stat.size;
  if (budget.remaining < 0) {
    throw new Error(
      `scenario fixtures exceed the ${MAX_FIXTURE_TOTAL_BYTES} byte aggregate limit at ${label}`,
    );
  }
  return readFileSync(path);
}

/**
 * Paths, relative to scenarios/fixtures/, of the fixtures a scenario reads: the
 * bare files it names (sqlDump, script sourceFile) and everything in the
 * per-scenario directory `fixtures/<id>/` when one exists. A `-solo` baseline
 * shares its swarm scenario's directory, as it shares its source file.
 */
export function scenarioFixtureFiles(
  scenario: Scenario,
  fixturesDir: string = FIXTURES_DIR,
): string[] {
  const files = new Set<string>();
  if (scenario.seed?.sqlDump) files.add(scenario.seed.sqlDump);
  for (const script of scenario.seed?.scripts ?? []) files.add(script.sourceFile);
  const own = scenario.baselineOf ?? scenario.id;
  if (existsSync(join(fixturesDir, own))) {
    for (const path of walkFiles(fixturesDir, own)) files.add(path);
  }
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
  const budget = { remaining: MAX_FIXTURE_TOTAL_BYTES };
  for (const name of scenarioFixtureFiles(scenario, fixturesDir)) {
    fixtures[name] = sha256(readFixture(join(fixturesDir, name), name, budget));
  }
  // A `-solo` baseline is derived in its swarm scenario's module, so it hashes that source.
  const sourceFile = `${scenario.baselineOf ?? scenario.id}.ts`;
  const source = sha256(
    normalizeSourceTokens(
      readFixture(join(scenariosDir, sourceFile), sourceFile, budget).toString("utf8"),
    ),
  );
  return { definition, fixtures, source };
}

/** 16 hex chars of sha256 over the canonical inputs. Pinned per version in scenarios/scenario-hashes.ts. */
export function hashScenario(scenario: Scenario, opts: { scenariosDir?: string } = {}): string {
  return sha256(JSON.stringify(scenarioHashInputs(scenario, opts))).slice(0, 16);
}

export { FIXTURES_DIR, SCENARIOS_DIR };
