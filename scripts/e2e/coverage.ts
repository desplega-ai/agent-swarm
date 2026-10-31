import type { ApiClient, HttpCall } from "./http";
import { asRecord, expectStatus } from "./http";
import type { ScenarioResult } from "./report";

type Operation = {
  method: string;
  template: string;
  group: string;
  /** Literal characters in the template; the longer literal wins a tie between matches. */
  literalLength: number;
};

export type SurfaceCoverage = {
  total: number;
  covered: number;
  /** Items the manifest excludes with a reason. Not part of `total`. */
  excluded: number;
  percent: number;
  uncovered: string[];
};

export type LatencyStats = { count: number; p50: number; p95: number; max: number };

export type FlowStatus = {
  name: string;
  description: string;
  scenarios: string[];
  /** `pass` when every named scenario passed; the first problem otherwise. */
  status: "pass" | "fail";
  detail?: string;
};

/**
 * An engine state surface: the distinct values a column can hold (a status enum, a step
 * type, an executor name) against the values the suite actually drove the engine through.
 * `unexpected` lists values the database holds that the manifest universe does not know,
 * so a new engine state is noticed the day it ships.
 */
export type StateSurfaceCoverage = SurfaceCoverage & { name: string; unexpected: string[] };

export type Coverage = {
  routes: SurfaceCoverage & {
    byGroup: Record<string, { total: number; covered: number }>;
    unknown: string[];
  };
  mcpTools: SurfaceCoverage;
  nodeTypes: SurfaceCoverage;
  stateSurfaces: StateSurfaceCoverage[];
  flows: FlowStatus[];
  /** Scenarios no flow names. Every scenario must belong to a flow so the flow list stays complete. */
  scenariosWithoutFlow: string[];
  /** Excluded items that were covered anyway. The exclusion is stale and must go. */
  staleExclusions: string[];
  /** Manifest entries that match nothing the server exposes. */
  deadExclusions: string[];
  /** Flow scenario names that no scenario file exports. */
  unknownFlowScenarios: string[];
  latency: { byGroup: Record<string, LatencyStats>; overall: LatencyStats };
};

/**
 * scripts/e2e/coverage-manifest.json. Every exclusion names the item exactly as coverage
 * reports it (`METHOD /template`, tool name, node type) and carries a reason a reviewer
 * can check. `flows` pins scenario names that must exist and pass in a strict run.
 */
export type StateSurfaceSpec = {
  name: string;
  /** One read-only SELECT returning a `value` column, run on the SUT database after the scenarios. */
  query: string;
  /** Every value the engine can produce. A value the database holds outside this list fails strict. */
  universe: string[];
  /** Values a black box cannot leave behind (transient states, paths that refuse before storing). */
  excluded: Array<{ value: string; reason: string }>;
};

export type CoverageManifest = {
  routes: Array<{ operation: string; reason: string }>;
  mcpTools: Array<{ name: string; reason: string }>;
  nodeTypes: Array<{ type: string; reason: string }>;
  stateSurfaces: StateSurfaceSpec[];
  flows: Record<string, { description: string; scenarios: string[] }>;
};

export const EMPTY_MANIFEST: CoverageManifest = {
  routes: [],
  mcpTools: [],
  nodeTypes: [],
  stateSurfaces: [],
  flows: {},
};

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const PARAM_RE = /\{([^}]+)\}/g;

/**
 * `{param}` matches one segment, also when it sits inside a segment (`{id}.json`).
 * A param named `path` is the server's `exact: false` tail (`/share/{path}`,
 * `/api/skills/{id}/files/{path}`) and matches across slashes.
 */
function templateRegex(template: string): RegExp {
  const source = template
    .split(PARAM_RE)
    .map((piece, index) =>
      index % 2 === 0 ? escapeRegex(piece) : piece === "path" ? ".+" : "[^/]+",
    )
    .join("");
  return new RegExp(`^${source}$`);
}

function literalLength(template: string): number {
  return template.replace(PARAM_RE, "").length;
}

function groupFor(template: string): string {
  const parts = template.split("/").filter(Boolean);
  return parts[0] === "api" ? (parts[1] ?? "api") : (parts[0] ?? "root");
}

function percent(covered: number, total: number): number {
  return total === 0 ? 100 : Math.round((covered / total) * 1000) / 10;
}

function readOperations(document: unknown): Operation[] {
  const paths = asRecord(asRecord(document).paths);
  const operations: Operation[] = [];
  for (const [template, pathItem] of Object.entries(paths)) {
    const item = asRecord(pathItem);
    for (const method of Object.keys(item)) {
      if (!METHODS.has(method)) continue;
      operations.push({
        method: method.toUpperCase(),
        template,
        group: groupFor(template),
        literalLength: literalLength(template),
      });
    }
  }
  return operations;
}

function matchOperation(call: HttpCall, operations: Operation[]): Operation | undefined {
  return operations
    .filter(
      (operation) =>
        operation.method === call.method && templateRegex(operation.template).test(call.path),
    )
    .sort((a, b) => b.literalLength - a.literalLength)[0];
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Math.round((sorted[index] ?? 0) * 100) / 100;
}

function latencyStats(values: number[]): LatencyStats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: Math.round((sorted[sorted.length - 1] ?? 0) * 100) / 100,
  };
}

function surface(
  universe: Iterable<string>,
  covered: ReadonlySet<string>,
  excluded: ReadonlySet<string>,
): SurfaceCoverage {
  const items = [...universe];
  const counted = items.filter((item) => !excluded.has(item));
  const hit = counted.filter((item) => covered.has(item));
  return {
    total: counted.length,
    covered: hit.length,
    excluded: items.length - counted.length,
    percent: percent(hit.length, counted.length),
    uncovered: counted.filter((item) => !covered.has(item)).sort(),
  };
}

export type CoverageInputs = {
  calls: readonly HttpCall[];
  toolUniverse: ReadonlySet<string>;
  calledTools: ReadonlySet<string>;
  /** Node types the engine executed during the run (distinct workflow_run_steps.nodeType). */
  observedNodeTypes: ReadonlySet<string>;
  scenarios: readonly ScenarioResult[];
  /** Every scenario the registry knows, selected or not. */
  knownScenarios: ReadonlySet<string>;
  /** Runs one manifest state-surface query on the SUT database and returns the `value` column. */
  queryValues: (sql: string) => string[];
  manifest: CoverageManifest;
};

export async function computeCoverage(api: ApiClient, inputs: CoverageInputs): Promise<Coverage> {
  const response = await api("GET", "/openapi.json");
  expectStatus(response, [200], "fetch OpenAPI document");
  const operations = readOperations(response.json);
  const executorTypes = await api("GET", "/api/executor-types");
  expectStatus(executorTypes, [200], "fetch executor types");
  const nodeTypeUniverse = new Set(
    (asRecord(executorTypes.json).executorTypes as unknown[]).map((entry) =>
      String(asRecord(entry).type),
    ),
  );

  const coveredKeys = new Set<string>();
  const unknown = new Set<string>();
  const latencyByGroup = new Map<string, number[]>();
  const allLatencies: number[] = [];
  for (const call of inputs.calls) {
    const operation = matchOperation(call, operations);
    if (operation) {
      coveredKeys.add(`${operation.method} ${operation.template}`);
      const bucket = latencyByGroup.get(operation.group) ?? [];
      bucket.push(call.durationMs);
      latencyByGroup.set(operation.group, bucket);
      allLatencies.push(call.durationMs);
    } else {
      unknown.add(`${call.method} ${call.path}`);
    }
  }

  const routeKeys = operations.map((operation) => `${operation.method} ${operation.template}`);
  const routeUniverse = new Set(routeKeys);
  const excludedRoutes = new Set(inputs.manifest.routes.map((entry) => entry.operation));
  const excludedTools = new Set(inputs.manifest.mcpTools.map((entry) => entry.name));
  const excludedNodeTypes = new Set(inputs.manifest.nodeTypes.map((entry) => entry.type));

  const byGroup: Record<string, { total: number; covered: number }> = {};
  for (const operation of operations) {
    const key = `${operation.method} ${operation.template}`;
    if (excludedRoutes.has(key)) continue;
    const group = byGroup[operation.group] ?? { total: 0, covered: 0 };
    byGroup[operation.group] = {
      total: group.total + 1,
      covered: group.covered + (coveredKeys.has(key) ? 1 : 0),
    };
  }

  const staleExclusions: string[] = [
    ...[...excludedRoutes].filter((key) => coveredKeys.has(key)).map((key) => `route ${key}`),
    ...[...excludedTools]
      .filter((name) => inputs.calledTools.has(name))
      .map((name) => `mcp tool ${name}`),
    ...[...excludedNodeTypes]
      .filter((type) => inputs.observedNodeTypes.has(type))
      .map((type) => `node type ${type}`),
  ].sort();
  const deadExclusions: string[] = [
    ...[...excludedRoutes].filter((key) => !routeUniverse.has(key)).map((key) => `route ${key}`),
    ...[...excludedTools]
      .filter((name) => !inputs.toolUniverse.has(name))
      .map((name) => `mcp tool ${name}`),
    ...[...excludedNodeTypes]
      .filter((type) => !nodeTypeUniverse.has(type))
      .map((type) => `node type ${type}`),
  ].sort();

  const byName = new Map(inputs.scenarios.map((scenario) => [scenario.name, scenario]));
  const unknownFlowScenarios = new Set<string>();
  const flows: FlowStatus[] = Object.entries(inputs.manifest.flows).map(([name, flow]) => {
    for (const scenario of flow.scenarios) {
      if (!inputs.knownScenarios.has(scenario)) unknownFlowScenarios.add(scenario);
    }
    const missing = flow.scenarios.filter((scenario) => !byName.has(scenario));
    const failed = flow.scenarios.filter((scenario) => byName.get(scenario)?.status !== "pass");
    let detail: string | undefined;
    if (missing.length > 0) detail = `not run: ${missing.join(", ")}`;
    else if (failed.length > 0) detail = `not passing: ${failed.join(", ")}`;
    return {
      name,
      description: flow.description,
      scenarios: flow.scenarios,
      status: detail ? "fail" : "pass",
      detail,
    };
  });

  const stateSurfaces: StateSurfaceCoverage[] = inputs.manifest.stateSurfaces.map((spec) => {
    const observed = new Set(inputs.queryValues(spec.query));
    const excluded = new Set(spec.excluded.map((entry) => entry.value));
    const universe = new Set(spec.universe);
    for (const value of excluded) {
      if (observed.has(value)) staleExclusions.push(`state ${spec.name}: ${value}`);
      if (!universe.has(value)) deadExclusions.push(`state ${spec.name}: ${value}`);
    }
    return {
      name: spec.name,
      ...surface(universe, observed, excluded),
      unexpected: [...observed].filter((value) => !universe.has(value)).sort(),
    };
  });
  staleExclusions.sort();
  deadExclusions.sort();
  const inAFlow = new Set(Object.values(inputs.manifest.flows).flatMap((flow) => flow.scenarios));
  const scenariosWithoutFlow =
    Object.keys(inputs.manifest.flows).length === 0
      ? []
      : [...inputs.knownScenarios].filter((name) => !inAFlow.has(name)).sort();

  const byGroupLatency: Record<string, LatencyStats> = {};
  for (const [group, values] of latencyByGroup) byGroupLatency[group] = latencyStats(values);

  return {
    routes: {
      ...surface(routeUniverse, coveredKeys, excludedRoutes),
      byGroup,
      unknown: [...unknown].sort(),
    },
    mcpTools: surface(inputs.toolUniverse, inputs.calledTools, excludedTools),
    nodeTypes: surface(nodeTypeUniverse, inputs.observedNodeTypes, excludedNodeTypes),
    stateSurfaces,
    flows,
    scenariosWithoutFlow,
    staleExclusions,
    deadExclusions,
    unknownFlowScenarios: [...unknownFlowScenarios].sort(),
    latency: { byGroup: byGroupLatency, overall: latencyStats(allLatencies) },
  };
}

/**
 * The strict contract: everything the server exposes is covered or deliberately
 * excluded, no exclusion is stale or dead, and every pinned flow passed. Returns the
 * reasons the contract fails, empty when it holds.
 */
export function strictFailures(coverage: Coverage): string[] {
  const failures: string[] = [];
  const list = (items: string[]) => items.map((item) => `  - ${item}`).join("\n");
  if (coverage.routes.uncovered.length > 0) {
    failures.push(
      `${coverage.routes.uncovered.length} route operation(s) are neither covered nor excluded:\n${list(coverage.routes.uncovered)}`,
    );
  }
  if (coverage.mcpTools.uncovered.length > 0) {
    failures.push(
      `${coverage.mcpTools.uncovered.length} MCP tool(s) are neither covered nor excluded:\n${list(coverage.mcpTools.uncovered)}`,
    );
  }
  if (coverage.nodeTypes.uncovered.length > 0) {
    failures.push(
      `${coverage.nodeTypes.uncovered.length} workflow node type(s) never executed:\n${list(coverage.nodeTypes.uncovered)}`,
    );
  }
  for (const state of coverage.stateSurfaces) {
    if (state.uncovered.length > 0) {
      failures.push(
        `state surface ${state.name}: ${state.uncovered.length} value(s) the suite never produced:\n${list(state.uncovered)}`,
      );
    }
    if (state.unexpected.length > 0) {
      failures.push(
        `state surface ${state.name}: ${state.unexpected.length} value(s) outside the manifest universe (new engine state, add it):\n${list(state.unexpected)}`,
      );
    }
  }
  if (coverage.scenariosWithoutFlow.length > 0) {
    failures.push(
      `${coverage.scenariosWithoutFlow.length} scenario(s) belong to no flow in coverage-manifest.json:\n${list(coverage.scenariosWithoutFlow)}`,
    );
  }
  if (coverage.staleExclusions.length > 0) {
    failures.push(
      `${coverage.staleExclusions.length} manifest exclusion(s) are covered anyway, remove them:\n${list(coverage.staleExclusions)}`,
    );
  }
  if (coverage.deadExclusions.length > 0) {
    failures.push(
      `${coverage.deadExclusions.length} manifest exclusion(s) match nothing the server exposes:\n${list(coverage.deadExclusions)}`,
    );
  }
  if (coverage.unknownFlowScenarios.length > 0) {
    failures.push(
      `${coverage.unknownFlowScenarios.length} flow scenario name(s) match no scenario file:\n${list(coverage.unknownFlowScenarios)}`,
    );
  }
  const failedFlows = coverage.flows.filter((flow) => flow.status === "fail");
  if (failedFlows.length > 0) {
    failures.push(
      `${failedFlows.length} flow(s) did not pass:\n${list(failedFlows.map((flow) => `${flow.name}: ${flow.detail ?? "failed"}`))}`,
    );
  }
  return failures;
}

export async function loadManifest(path: string): Promise<CoverageManifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) return EMPTY_MANIFEST;
  const raw = asRecord(await file.json());
  const manifest: CoverageManifest = {
    routes: Array.isArray(raw.routes) ? raw.routes.map(asRecord).map(routeEntry) : [],
    mcpTools: Array.isArray(raw.mcpTools) ? raw.mcpTools.map(asRecord).map(toolEntry) : [],
    nodeTypes: Array.isArray(raw.nodeTypes) ? raw.nodeTypes.map(asRecord).map(nodeEntry) : [],
    stateSurfaces: Array.isArray(raw.stateSurfaces)
      ? raw.stateSurfaces.map(asRecord).map(stateSurfaceEntry)
      : [],
    flows: {},
  };
  for (const [name, value] of Object.entries(asRecord(raw.flows ?? {}))) {
    const flow = asRecord(value);
    const scenarios = flow.scenarios;
    if (!Array.isArray(scenarios) || scenarios.some((item) => typeof item !== "string")) {
      throw new Error(`coverage-manifest flow "${name}" needs a scenarios string array`);
    }
    manifest.flows[name] = {
      description: typeof flow.description === "string" ? flow.description : "",
      scenarios: scenarios as string[],
    };
  }
  const surfaceNames = findDuplicates(manifest.stateSurfaces.map((spec) => spec.name));
  if (surfaceNames.length > 0) {
    throw new Error(`coverage-manifest lists duplicate state surfaces: ${surfaceNames.join(", ")}`);
  }
  const duplicates = findDuplicates([
    ...manifest.routes.map((entry) => `route ${entry.operation}`),
    ...manifest.mcpTools.map((entry) => `mcp tool ${entry.name}`),
    ...manifest.nodeTypes.map((entry) => `node type ${entry.type}`),
  ]);
  if (duplicates.length > 0) {
    throw new Error(`coverage-manifest lists duplicates: ${duplicates.join(", ")}`);
  }
  return manifest;
}

function reasonOf(entry: Record<string, unknown>, label: string): string {
  const reason = entry.reason;
  if (typeof reason !== "string" || reason.trim().length < 10) {
    throw new Error(`coverage-manifest ${label} needs a reason of at least 10 characters`);
  }
  return reason;
}

function routeEntry(entry: Record<string, unknown>) {
  const operation = entry.operation;
  if (typeof operation !== "string" || !/^(GET|POST|PUT|PATCH|DELETE) \//.test(operation)) {
    throw new Error(`coverage-manifest route entry needs "METHOD /path": ${JSON.stringify(entry)}`);
  }
  return { operation, reason: reasonOf(entry, `route ${operation}`) };
}

function toolEntry(entry: Record<string, unknown>) {
  const name = entry.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`coverage-manifest mcpTools entry needs a name: ${JSON.stringify(entry)}`);
  }
  return { name, reason: reasonOf(entry, `mcp tool ${name}`) };
}

function nodeEntry(entry: Record<string, unknown>) {
  const type = entry.type;
  if (typeof type !== "string" || type.length === 0) {
    throw new Error(`coverage-manifest nodeTypes entry needs a type: ${JSON.stringify(entry)}`);
  }
  return { type, reason: reasonOf(entry, `node type ${type}`) };
}

function stateSurfaceEntry(entry: Record<string, unknown>): StateSurfaceSpec {
  const name = entry.name;
  const query = entry.query;
  if (typeof name !== "string" || !/^[a-z0-9-]+$/.test(name)) {
    throw new Error(
      `coverage-manifest stateSurfaces entry needs a kebab-case name: ${JSON.stringify(entry)}`,
    );
  }
  // Read-only by construction: one SELECT, no statement separator, an aliased `value` column.
  if (
    typeof query !== "string" ||
    !/^\s*SELECT\s/i.test(query) ||
    query.includes(";") ||
    !/\bAS\s+value\b/i.test(query)
  ) {
    throw new Error(
      `coverage-manifest state surface ${name} needs one SELECT ... AS value query without ';'`,
    );
  }
  const universe = entry.universe;
  if (
    !Array.isArray(universe) ||
    universe.length === 0 ||
    universe.some((value) => typeof value !== "string" || value.length === 0)
  ) {
    throw new Error(
      `coverage-manifest state surface ${name} needs a non-empty universe of strings`,
    );
  }
  const excludedRaw = Array.isArray(entry.excluded) ? entry.excluded.map(asRecord) : [];
  const excluded = excludedRaw.map((item) => {
    const value = item.value;
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`coverage-manifest state surface ${name} has an exclusion without a value`);
    }
    return { value, reason: reasonOf(item, `state ${name}: ${value}`) };
  });
  const excludedValues = excluded.map((item) => item.value);
  if (
    findDuplicates(universe as string[]).length > 0 ||
    findDuplicates(excludedValues).length > 0
  ) {
    throw new Error(`coverage-manifest state surface ${name} repeats a value`);
  }
  return { name, query, universe: universe as string[], excluded };
}

function findDuplicates(items: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) duplicates.add(item);
    seen.add(item);
  }
  return [...duplicates];
}
