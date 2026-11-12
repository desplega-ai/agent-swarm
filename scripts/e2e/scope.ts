/**
 * Picks the E2E Contract scenarios a diff needs, for `bun run check:local`.
 *
 *   bun scripts/e2e/scope.ts <changed file>...   (or one path per line on stdin)
 *
 * Prints one line on stdout and the reasons on stderr:
 *   skip                 no changed file reaches the SUT or the runner
 *   only <a>,<b>,...     scenarios for `bun run e2e --only`
 *   full                 the diff cannot be scoped; run every scenario
 *
 * The map is static text matching, so it stays cheap:
 *   - a scenario file selects its own scenarios; a scenario helper selects every
 *     scenario file that imports it (directly or through another local import)
 *   - a route file (src/http/) selects scenarios whose sources (helpers included)
 *     name one of its route groups (`/api/<group>`, the grouping coverage.ts uses)
 *   - a tool file (src/tools/) selects scenarios that name one of its tools
 *   - a workflow executor (src/workflows/executors/) selects the engine that owns the
 *     node types in coverage-manifest.json, through that engine's route groups and tools
 * Any other file the SUT or the runner loads (src/be/, src/types.ts, the harness,
 * package.json, templates/) cannot be scoped, so it asks for the full run. A mapped
 * file no scenario reaches asks for the full run too. Selected scenarios bring their
 * `needs`. CI still runs everything, sharded, with --strict.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { groupFor } from "./coverage";
import type { Scenario } from "./run";
import { scenarioFiles, scenariosIn } from "./scenarios/registry";

const SCENARIOS_DIR = "scripts/e2e/scenarios";
const ROOT = join(import.meta.dir, "../..");

// The E2E filter in .github/workflows/merge-gate.yml (detect-changes): what the SUT and
// the runner load. Keep the two in sync.
const E2E_INPUTS =
  /^(src\/|packages\/|templates\/|vendored-openapi\/|slack-manifest\.json$|scripts\/e2e\/|scripts\/check-e2e-boundary\.sh$|package\.json$|bun\.lock|bunfig\.toml$|tsconfig\.json$|apps\/(ui|templates-ui|evals)\/package\.json$)/;
// Inside those inputs, neither the SUT nor a non-strict local run loads these: unit tests,
// the Playwright package, runner docs, and the coverage manifest (only --strict and
// --shard read it; CI's strict merge still checks it). CI runs E2E for them anyway.
const NOT_LOADED =
  /^src\/tests\/|\.test\.tsx?$|^packages\/ui-e2e\/|^scripts\/e2e\/.*\.md$|^scripts\/e2e\/coverage-manifest\.json$/;
// Seeded skills reach a scenario only through the skills routes and tools.
const SKILL_SOURCES = /^templates\/(skills\/|ai-toolbox\.manifest\.json$)/;

type Manifest = {
  engines: Array<{ name: string; routeGroups: string[]; tools: string[]; nodeTypes?: boolean }>;
};

type Plan = { kind: "skip" } | { kind: "full"; reason: string } | { kind: "only"; names: string[] };

const read = (path: string) => Bun.file(join(ROOT, path)).text();
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A route group as scenario text names it: `/api/<group>` or a root `/<group>`. */
function groupPattern(group: string, apiGroup: boolean): RegExp {
  const end = "(?=[/?\"'`]|$)";
  return apiGroup
    ? new RegExp(`/api/${escapeRegex(group)}${end}`, "m")
    : new RegExp(`(?<![A-Za-z0-9_-])/${escapeRegex(group)}${end}`, "m");
}

/** A tool name as scenario text names it: a quoted literal. `*` is a manifest wildcard. */
function toolPattern(tool: string): RegExp {
  const body = tool
    .split("*")
    .map((part) => escapeRegex(part))
    .join("[a-z0-9-]*");
  return new RegExp(`["'\`]${body}["'\`]`);
}

function routePatterns(source: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (const match of source.matchAll(/\bpath:\s*["'`](\/[^"'`]*)["'`]/g)) {
    const template = match[1] ?? "";
    patterns.push(groupPattern(groupFor(template), template.startsWith("/api/")));
  }
  return patterns;
}

function toolPatterns(source: string): RegExp[] {
  return [...source.matchAll(/createToolRegistrar\([^)]*\)\(\s*["'`]([a-z0-9-]+)["'`]/g)].map(
    (match) => toolPattern(match[1] ?? ""),
  );
}

/** Each scenario file's text plus every local file it imports, transitively. */
async function scenarioTexts(
  files: string[],
): Promise<Map<string, { text: string; deps: Set<string> }>> {
  const raw = new Map<string, string>();
  for (const file of await readdir(join(ROOT, SCENARIOS_DIR))) {
    if (file.endsWith(".ts")) raw.set(file, await read(`${SCENARIOS_DIR}/${file}`));
  }
  const imports = (file: string) =>
    [...(raw.get(file) ?? "").matchAll(/from\s+["']\.\/([a-z0-9-]+)["']/g)].map(
      (match) => `${match[1]}.ts`,
    );
  const texts = new Map<string, { text: string; deps: Set<string> }>();
  for (const file of files) {
    const deps = new Set<string>();
    const queue = [file];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (deps.has(next) || !raw.has(next)) continue;
      deps.add(next);
      queue.push(...imports(next));
    }
    texts.set(file, { text: [...deps].map((dep) => raw.get(dep)).join("\n"), deps });
  }
  return texts;
}

export async function planScope(changed: string[]): Promise<{ plan: Plan; notes: string[] }> {
  const notes: string[] = [];
  const relevant = changed.filter((path) => E2E_INPUTS.test(path) && !NOT_LOADED.test(path));
  if (relevant.length === 0)
    return { plan: { kind: "skip" }, notes: ["no changed file reaches the SUT or the runner"] };

  const files = await scenarioFiles();
  const byFile = new Map<string, Scenario[]>();
  for (const file of files) byFile.set(file, await scenariosIn(file));
  const texts = await scenarioTexts(files);
  const manifest = JSON.parse(await read("scripts/e2e/coverage-manifest.json")) as Manifest;

  const selected = new Set<string>();
  const fullReasons: string[] = [];
  const selectFiles = (path: string, match: (file: string) => boolean): Plan | undefined => {
    const hits = files.filter(match);
    if (hits.length === 0) return { kind: "full", reason: `no scenario reaches ${path}` };
    const names = hits.flatMap((file) => (byFile.get(file) ?? []).map((scenario) => scenario.name));
    for (const name of names) selected.add(name);
    notes.push(`${path} -> ${names.length} scenario(s)`);
    return undefined;
  };
  const byPatterns = (path: string, patterns: RegExp[]) =>
    patterns.length === 0
      ? ({ kind: "full", reason: `found no route or tool name in ${path}` } as Plan)
      : selectFiles(path, (file) =>
          patterns.some((pattern) => pattern.test(texts.get(file)?.text ?? "")),
        );

  for (const path of relevant) {
    let plan: Plan | undefined;
    const base = path.slice(SCENARIOS_DIR.length + 1);
    if (path.startsWith(`${SCENARIOS_DIR}/`) && files.includes(base)) {
      plan = selectFiles(path, (file) => file === base);
    } else if (
      path.startsWith(`${SCENARIOS_DIR}/`) &&
      !base.includes("/") &&
      base !== "registry.ts"
    ) {
      plan = selectFiles(path, (file) => texts.get(file)?.deps.has(base) ?? false);
    } else if (/^src\/http\/[^/]+\.ts$/.test(path)) {
      plan = byPatterns(path, routePatterns(await read(path).catch(() => "")));
    } else if (/^src\/tools\/.+\.ts$/.test(path)) {
      plan = byPatterns(path, toolPatterns(await read(path).catch(() => "")));
    } else if (SKILL_SOURCES.test(path)) {
      plan = byPatterns(path, [groupPattern("skills", true), toolPattern("skill-*")]);
    } else if (/^src\/workflows\/executors\/[^/]+\.ts$/.test(path)) {
      const engine = manifest.engines.find((entry) => entry.nodeTypes);
      plan = engine
        ? byPatterns(path, [
            ...engine.routeGroups.map((group) => groupPattern(group, true)),
            ...engine.tools.map(toolPattern),
          ])
        : { kind: "full", reason: "coverage-manifest.json names no engine that owns node types" };
    } else {
      plan = { kind: "full", reason: `${path} has no scenario map` };
    }
    if (plan?.kind === "full") fullReasons.push(plan.reason);
  }
  if (fullReasons.length > 0)
    return { plan: { kind: "full", reason: fullReasons.join("; ") }, notes };

  // A selected scenario may read state an earlier one left: bring its `needs` along.
  const needsOf = new Map(
    [...byFile.values()].flat().map((scenario) => [scenario.name, scenario.needs ?? []]),
  );
  const queue = [...selected];
  while (queue.length > 0) {
    for (const name of needsOf.get(queue.pop()!) ?? []) {
      if (!selected.has(name)) {
        selected.add(name);
        queue.push(name);
      }
    }
  }
  if (selected.size >= needsOf.size)
    return { plan: { kind: "full", reason: "the diff reaches every scenario" }, notes };
  return { plan: { kind: "only", names: [...selected].sort() }, notes };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const changed = (args.length > 0 ? args : (await Bun.stdin.text()).split("\n"))
    .map((line) => line.trim())
    .filter(Boolean);
  const { plan, notes } = await planScope(changed);
  for (const note of notes) console.error(`  ${note}`);
  if (plan.kind === "full") console.error(`  full run: ${plan.reason}`);
  console.log(plan.kind === "only" ? `only ${plan.names.join(",")}` : plan.kind);
}
