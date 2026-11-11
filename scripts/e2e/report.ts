import { resolve } from "node:path";
import { type Coverage, strictFailures } from "./coverage";
import type { QuarantineEntry } from "./quarantine";
import { type Observations, parseShard, type Shard } from "./shard";

export class SkipError extends Error {}

/** `flaky`: failed, then passed its rerun on a fresh API. It does not fail the run. */
export type RunStatus = "pass" | "fail" | "skip" | "flaky";
export type ScenarioAttempt = { status: RunStatus; durationMs: number; error?: string };
export type ScenarioResult = {
  name: string;
  status: RunStatus;
  /** Wall-clock over every attempt. */
  durationMs: number;
  error?: string;
  /** Present when the scenario reran: the first attempt, then the rerun. */
  attempts?: ScenarioAttempt[];
  /** Present when quarantine.json lists the scenario: a failure here cannot fail the run. */
  quarantine?: Omit<QuarantineEntry, "scenario">;
};

/** A failure that fails the run: not quarantined. */
export function failsRun(result: ScenarioResult): boolean {
  return result.status === "fail" && !result.quarantine;
}

/** Status label for consoles and tables: FLAKY, FAIL (quarantined), PASS. */
export function statusLabel(result: ScenarioResult): string {
  const label = result.status.toUpperCase();
  return result.quarantine && result.status !== "pass" ? `${label} (quarantined)` : label;
}
/** Session-cost rows the API stored for one harness attempt, summed. */
export type HarnessCost = {
  records: number;
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Distinct `costSource` values, comma-joined (harness, pricing-table, unpriced). */
  costSource: string;
};
/** `auth-chain`: the codex CLI ran but its rotated OAuth chain could not be persisted. */
export type HarnessFailureKind = "setup" | "timeout" | "credential" | "task" | "auth-chain";
export type HarnessAttempt = {
  status: "pass" | "fail";
  durationMs: number;
  error?: string;
  failureKind?: HarnessFailureKind;
  cost?: HarnessCost;
  /** Last lines of the worker log, present on failure only. */
  logTail?: string;
};
export type HarnessResult = {
  provider: string;
  /** Selected Claude transport. Absent in older results and for other providers. */
  transport?: "cli" | "sdk";
  model: string;
  /** Status of the final attempt. */
  status: "pass" | "fail";
  /** Wall-clock over every attempt. */
  durationMs: number;
  error?: string;
  failureKind?: HarnessFailureKind;
  attempts: HarnessAttempt[];
  /** Cost of the final attempt. */
  cost?: HarnessCost;
  /** USD summed over every attempt, retries included. */
  totalCostUsd: number;
  /** Access-token expiry of the seeded OAuth blob. Codex only. */
  credentialExpiresAt?: string;
  logTail?: string;
};

/** One shard as the merge job saw it. */
export type ShardSummary = Shard & { durationMs: number; ok: boolean; scenarios: number };

export type E2eResult = {
  startedAt: string;
  /** Wall-clock. A merged result takes the slowest shard: the shards ran in parallel. */
  durationMs: number;
  /** Absent on a merged result: it booted no API. */
  sut?: { port: number; dbPath: string; logPath: string };
  /** `--shard i/n`: the band this run covered and the raw data the merge job unions. */
  shard?: Shard & { observations: Observations };
  /** A merged result: one entry per shard result it read. */
  shards?: ShardSummary[];
  /** Reasons the merge itself fails the run: a missing, duplicate or unreadable shard. */
  mergeProblems?: string[];
  scenarios: ScenarioResult[];
  harness: HarnessResult[];
  coverage: Coverage;
  /** quarantine.json as loaded, plus the reasons it fails the run (expired, unknown, duplicate). */
  quarantine?: { entries: QuarantineEntry[]; problems: string[] };
  gates: {
    minRouteCoverage: number;
    minToolCoverage: number;
    /** `--strict`: every exposed route, tool and node type is covered or excluded. */
    strict: boolean;
    /** Reasons the strict contract failed. Empty when it held or strict was off. */
    failures: string[];
    passed: boolean;
  };
  ok: boolean;
};

export type Options = {
  harness: string[];
  harnessAttempts: number;
  only?: Set<string>;
  skip: Set<string>;
  group?: string;
  list: boolean;
  help: boolean;
  jsonPath: string;
  summaryPath?: string;
  keep: boolean;
  minRouteCoverage: number;
  minToolCoverage: number;
  strict: boolean;
  sutEnv: Record<string, string>;
  visualsDir?: string;
  shard?: Shard;
  /** `--coverage`: lcov per API process lands here (`./e2e-coverage`). */
  coverageDir?: string;
};

export const helpText = `Usage: bun run e2e [options]

Options:
  --harness p1,p2               Run real harness legs after the contract scenarios
                                (claude, codex, pi, opencode, dsh, cursor, amp, grok, fx, acp)
  --harness-attempts N          Run a failed harness leg again, N attempts in total
                                (1 through 5, default: 1)
  --only name,name              Run only named contract scenarios
  --skip name,name              Skip named contract scenarios
  --group name                  Run only contract scenarios tagged with this group
  --shard i/n                   Run one fixed band of scenarios by order (n = 3). Coverage
                                gates move to the merge step: bun scripts/e2e/merge.ts
  --coverage                    Run the API under bun test with lcov on: one
                                ./e2e-coverage/<process>/lcov.info per API process. Report
                                it with: bun scripts/e2e/diff-coverage.ts
  --list                        Print contract scenario names and exit
  --json path                   JSON result path (default: ./e2e-results.json)
  --summary-md path             Optional Markdown summary path
  --sut-env KEY=VALUE           Set a SUT environment variable (repeatable)
  --visuals dir                 Write a Slack journal and visual manifest
  --keep                        Keep the database, logs, and temporary directories
  --min-route-coverage N        Minimum route coverage percent (default: 0)
  --min-tool-coverage N         Minimum MCP tool coverage percent (default: 0)
  --strict                      Fail unless every route operation, MCP tool and workflow
                                node type is covered or excluded in coverage-manifest.json,
                                no exclusion is stale or dead, and every pinned flow passed
  --help                        Show this help`;

function optionValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function listValue(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function coverageValue(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100) {
    throw new Error(`${flag} must be a number from 0 through 100`);
  }
  return number;
}

function attemptsValue(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 5) {
    throw new Error("--harness-attempts must be an integer from 1 through 5");
  }
  return number;
}

function sutEnvValue(value: string): [string, string] {
  const separator = value.indexOf("=");
  if (separator < 1) throw new Error("--sut-env requires KEY=VALUE");
  return [value.slice(0, separator), value.slice(separator + 1)];
}

export function parseOptions(
  args: string[],
  scenarioNames: string[],
  groupNames: string[] = [],
): Options {
  const options: Options = {
    harness: [],
    harnessAttempts: 1,
    skip: new Set(),
    list: false,
    help: false,
    jsonPath: "./e2e-results.json",
    keep: false,
    minRouteCoverage: 0,
    minToolCoverage: 0,
    strict: false,
    sutEnv: {},
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = () => optionValue(args, index++, arg);
    if (arg === "--harness") options.harness = listValue(value());
    else if (arg === "--harness-attempts") options.harnessAttempts = attemptsValue(value());
    else if (arg === "--only") options.only = new Set(listValue(value()));
    else if (arg === "--skip") options.skip = new Set(listValue(value()));
    else if (arg === "--group") options.group = value();
    else if (arg === "--json") options.jsonPath = value();
    else if (arg === "--summary-md") options.summaryPath = value();
    else if (arg === "--sut-env") {
      const [key, envValue] = sutEnvValue(value());
      options.sutEnv[key] = envValue;
    } else if (arg === "--visuals") options.visualsDir = value();
    else if (arg === "--min-route-coverage") options.minRouteCoverage = coverageValue(value(), arg);
    else if (arg === "--min-tool-coverage") options.minToolCoverage = coverageValue(value(), arg);
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--shard") options.shard = parseShard(value());
    else if (arg === "--coverage") options.coverageDir = resolve("e2e-coverage");
    else if (arg === "--list") options.list = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--keep") options.keep = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  // A band alone covers a fraction of the surface; the merge step gates the union.
  if (
    options.shard &&
    (options.strict || options.minRouteCoverage > 0 || options.minToolCoverage > 0)
  ) {
    throw new Error("--shard cannot gate coverage: pass --strict and minimums to merge.ts");
  }
  if (options.shard && options.harness.length > 0) {
    throw new Error("--shard runs contract scenarios only; drop --harness");
  }
  const names = new Set(scenarioNames);
  for (const name of [...(options.only ?? []), ...options.skip]) {
    if (!names.has(name)) throw new Error(`Unknown scenario: ${name}`);
  }
  if (options.group && !new Set(groupNames).has(options.group)) {
    throw new Error(`Unknown scenario group: ${options.group}`);
  }
  for (const provider of options.harness) {
    if (
      !["claude", "codex", "pi", "opencode", "dsh", "cursor", "amp", "grok", "fx", "acp"].includes(
        provider,
      )
    ) {
      throw new Error(`Unknown harness provider: ${provider}`);
    }
  }
  return options;
}

const colors = process.stdout.isTTY
  ? { pass: "\x1b[32m", fail: "\x1b[31m", skip: "\x1b[33m", flaky: "\x1b[35m", reset: "\x1b[0m" }
  : { pass: "", fail: "", skip: "", flaky: "", reset: "" };

export function seconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function printScenario(result: ScenarioResult): void {
  const label = statusLabel(result);
  const detail = result.error
    ? `: ${result.status === "flaky" ? "passed on rerun; first attempt: " : ""}${result.error}`
    : "";
  const attempts = result.attempts ? `, ${result.attempts.length} attempts` : "";
  const duration = result.status === "skip" ? "" : ` (${seconds(result.durationMs)}${attempts})`;
  console.log(`${colors[result.status]}${label}${colors.reset} ${result.name}${duration}${detail}`);
}

export function usd(amount: number): string {
  return `$${amount.toFixed(4)}`;
}

/** One cell for a harness cost: the USD figure, or "no record" when the API stored nothing. */
export function costCell(cost: HarnessCost | undefined): string {
  if (!cost) return "";
  if (cost.records === 0) return "no record";
  return `${usd(cost.totalUsd)} (${cost.costSource})`;
}

/** Preserve the historical CLI label while keeping SDK results distinct. */
export function harnessLegName(leg: HarnessResult): string {
  return leg.provider === "claude" && leg.transport === "sdk" ? "claude-sdk" : leg.provider;
}

export function printHarness(result: HarnessResult): void {
  const color = colors[result.status];
  const detail = result.error ? `: ${result.error}` : "";
  const attempts = result.attempts.length > 1 ? `, ${result.attempts.length} attempts` : "";
  const cost = result.cost ? `, ${costCell(result.cost)}` : "";
  console.log(
    `${color}${result.status.toUpperCase()}${colors.reset} harness ${harnessLegName(result)} ` +
      `(${result.model}, ${seconds(result.durationMs)}${attempts}${cost})${detail}`,
  );
}

export function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

export function harnessTable(legs: HarnessResult[]): string[] {
  return [
    "| Provider | Model | Status | Attempts | Duration | Cost | Tokens in+cache / out | Error |",
    "| --- | --- | --- | ---: | ---: | --- | ---: | --- |",
    ...legs.map((leg) => {
      // Input counts cache reads and writes, the same unified formula the cost pages use.
      const tokens = leg.cost?.records
        ? `${leg.cost.inputTokens + leg.cost.cacheReadTokens + leg.cost.cacheWriteTokens} / ${leg.cost.outputTokens}`
        : "";
      return `| ${harnessLegName(leg)} | ${markdownCell(leg.model)} | ${leg.status.toUpperCase()} | ${leg.attempts.length} | ${seconds(leg.durationMs)} | ${costCell(leg.cost)} | ${tokens} | ${markdownCell(leg.error ?? "")} |`;
    }),
  ];
}

/** Collapsed worker-log tails for every failed attempt, so the raw job log is never required. */
export function harnessFailureDetails(legs: HarnessResult[]): string[] {
  const lines: string[] = [];
  for (const leg of legs) {
    leg.attempts.forEach((attempt, index) => {
      if (attempt.status !== "fail") return;
      lines.push(
        "<details>",
        `<summary>${harnessLegName(leg)} attempt ${index + 1}: ${markdownCell(attempt.error ?? "failed")}${attempt.failureKind ? ` (${attempt.failureKind})` : ""}</summary>`,
        "",
        "```text",
        attempt.logTail?.replaceAll("```", "` ` `") ?? "(no worker log)",
        "```",
        "",
        "</details>",
        "",
      );
    });
  }
  return lines;
}

/** Route and tool minimums plus `--strict`, on whatever coverage the run computed. */
export function evaluateGates(
  coverage: Coverage,
  coverageError: string | undefined,
  options: Pick<Options, "strict" | "minRouteCoverage" | "minToolCoverage">,
): E2eResult["gates"] {
  const failures = options.strict && !coverageError ? strictFailures(coverage) : [];
  const passed =
    !coverageError &&
    coverage.routes.percent >= options.minRouteCoverage &&
    coverage.mcpTools.percent >= options.minToolCoverage &&
    failures.length === 0;
  return {
    minRouteCoverage: options.minRouteCoverage,
    minToolCoverage: options.minToolCoverage,
    strict: options.strict,
    failures,
    passed,
  };
}

/** The closing console block: totals, problems, coverage and the gate verdicts. */
export function printTotals(result: E2eResult): void {
  const { scenarios, harness, coverage, gates } = result;
  const failed =
    scenarios.filter(failsRun).length + harness.filter((leg) => leg.status === "fail").length;
  const passes =
    scenarios.filter((scenario) => scenario.status === "pass").length +
    harness.filter((leg) => leg.status === "pass").length;
  const count = (status: RunStatus) => scenarios.filter((item) => item.status === status).length;
  const quarantinedFailures = scenarios.filter(
    (scenario) => scenario.status === "fail" && scenario.quarantine,
  ).length;
  console.log(
    `${result.ok ? "PASS" : "FAIL"}: ${passes} passed, ${failed} failed, ${count("skip")} skipped, ${count("flaky")} flaky` +
      (quarantinedFailures > 0 ? `, ${quarantinedFailures} quarantined failed` : ""),
  );
  for (const problem of result.mergeProblems ?? []) console.error(`Shard merge failed: ${problem}`);
  for (const problem of result.quarantine?.problems ?? [])
    console.error(`Quarantine gate failed: ${problem}`);
  const surfaceLine = (label: string, surface: Coverage["mcpTools"]) =>
    `${label}: ${surface.covered}/${surface.total} (${surface.percent.toFixed(1)}%)` +
    (surface.excluded > 0 ? `, ${surface.excluded} excluded` : "");
  console.log(surfaceLine("routes", coverage.routes));
  console.log(surfaceLine("mcp tools", coverage.mcpTools));
  console.log(surfaceLine("workflow node types", coverage.nodeTypes));
  for (const state of coverage.stateSurfaces)
    console.log(surfaceLine(`state ${state.name}`, state));
  for (const engine of coverage.engines) {
    console.log(
      `engine ${engine.name}: ${engine.percent.toFixed(1)}% (routes ${engine.routes.covered}/${engine.routes.total}, tools ${engine.mcpTools.covered}/${engine.mcpTools.total}, node types ${engine.nodeTypes.covered}/${engine.nodeTypes.total}, states ${engine.stateValues.covered}/${engine.stateValues.total})`,
    );
  }
  console.log(
    `latency: p50 ${coverage.latency.overall.p50} ms, p95 ${coverage.latency.overall.p95} ms over ${coverage.latency.overall.count} calls`,
  );
  if (!gates.passed) {
    if (coverage.routes.percent < gates.minRouteCoverage)
      console.error(
        `Route coverage gate failed: ${coverage.routes.percent.toFixed(1)}% < ${gates.minRouteCoverage}%`,
      );
    if (coverage.mcpTools.percent < gates.minToolCoverage)
      console.error(
        `MCP tool coverage gate failed: ${coverage.mcpTools.percent.toFixed(1)}% < ${gates.minToolCoverage}%`,
      );
    for (const failure of gates.failures) console.error(`Strict coverage gate failed: ${failure}`);
  }
}

export function markdownSummary(result: E2eResult): string {
  const lines = [
    "## Black-box E2E",
    "",
    `Overall: **${result.ok ? "PASS" : "FAIL"}**`,
    "",
    "### Scenarios",
    "",
    "| Scenario | Status | Attempts | Duration | Error |",
    "| --- | --- | ---: | ---: | --- |",
    ...result.scenarios.map(
      (scenario) =>
        `| ${scenario.name} | ${statusLabel(scenario)} | ${scenario.attempts?.length ?? 1} | ${seconds(scenario.durationMs)} | ${markdownCell(scenario.error ?? "")} |`,
    ),
  ];
  if (result.shard) {
    lines.splice(
      4,
      0,
      `Shard ${result.shard.index}/${result.shard.total}: coverage gates run on the merged result.`,
      "",
    );
  }
  if (result.shards) {
    lines.push(
      "",
      "### Shards",
      "",
      "| Shard | Status | Scenarios | Duration |",
      "| --- | --- | ---: | ---: |",
      ...result.shards.map(
        (shard) =>
          `| ${shard.index}/${shard.total} | ${shard.ok ? "PASS" : "FAIL"} | ${shard.scenarios} | ${seconds(shard.durationMs)} |`,
      ),
    );
  }
  if ((result.mergeProblems ?? []).length > 0) {
    lines.push(
      "",
      "Shard merge fails the run:",
      "",
      ...(result.mergeProblems ?? []).map((p) => `- ${p}`),
    );
  }
  const flaky = result.scenarios.filter((scenario) => scenario.status === "flaky");
  if (flaky.length > 0) {
    lines.push("", `Flaky (passed on rerun): ${flaky.map((scenario) => scenario.name).join(", ")}`);
  }
  const quarantineProblems = result.quarantine?.problems ?? [];
  if (quarantineProblems.length > 0) {
    lines.push(
      "",
      "Quarantine file fails the run:",
      "",
      ...quarantineProblems.map((p) => `- ${p}`),
    );
  }
  if (result.harness.length > 0) {
    lines.push(
      "",
      "### Harness",
      "",
      ...harnessTable(result.harness),
      "",
      ...harnessFailureDetails(result.harness),
    );
  }
  const surfaceLine = (label: string, surface: Coverage["routes"] | Coverage["mcpTools"]) =>
    `${label}: ${surface.covered}/${surface.total} (${surface.percent.toFixed(1)}%)` +
    (surface.excluded > 0 ? `, ${surface.excluded} excluded` : "");
  lines.push(
    "",
    "### Coverage",
    "",
    surfaceLine("routes", result.coverage.routes),
    "",
    surfaceLine("mcp tools", result.coverage.mcpTools),
    "",
    surfaceLine("workflow node types", result.coverage.nodeTypes),
    "",
    ...result.coverage.engines.flatMap((engine) => [
      `engine ${engine.name}: ${engine.percent.toFixed(1)}% (routes ${engine.routes.covered}/${engine.routes.total}, tools ${engine.mcpTools.covered}/${engine.mcpTools.total}, node types ${engine.nodeTypes.covered}/${engine.nodeTypes.total}, states ${engine.stateValues.covered}/${engine.stateValues.total})`,
      "",
    ]),
    ...result.coverage.stateSurfaces.flatMap((state) => [
      surfaceLine(`state ${state.name}`, state) +
        (state.unexpected.length > 0 ? `, unexpected: ${state.unexpected.join(", ")}` : ""),
      "",
    ]),
    `coverage gates: ${result.gates.passed ? "PASS" : "FAIL"} (routes >= ${result.gates.minRouteCoverage}%, MCP tools >= ${result.gates.minToolCoverage}%${result.gates.strict ? ", strict" : ""})`,
    "",
  );
  if (result.gates.failures.length > 0) {
    lines.push("```text", ...result.gates.failures, "```", "");
  }
  if (result.coverage.flows.length > 0) {
    lines.push(
      "| Flow | Status | Scenarios | Detail |",
      "| --- | --- | --- | --- |",
      ...result.coverage.flows.map(
        (flow) =>
          `| ${flow.name} | ${flow.status.toUpperCase()} | ${markdownCell(flow.scenarios.join(", "))} | ${markdownCell(flow.detail ?? "")} |`,
      ),
      "",
    );
  }
  lines.push(
    "| Group | Covered | Total | p50 ms | p95 ms | max ms | calls |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...Object.entries(result.coverage.routes.byGroup)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, counts]) => {
        const latency = result.coverage.latency.byGroup[group];
        return `| ${group} | ${counts.covered} | ${counts.total} | ${latency?.p50 ?? ""} | ${latency?.p95 ?? ""} | ${latency?.max ?? ""} | ${latency?.count ?? 0} |`;
      }),
    "",
    `overall latency: p50 ${result.coverage.latency.overall.p50} ms, p95 ${result.coverage.latency.overall.p95} ms, max ${result.coverage.latency.overall.max} ms over ${result.coverage.latency.overall.count} calls`,
    "",
    "<details>",
    "<summary>Uncovered routes</summary>",
    "",
    ...result.coverage.routes.uncovered.map((route) => `- ${route}`),
    "",
    "</details>",
    "",
    "<details>",
    "<summary>Uncovered MCP tools</summary>",
    "",
    ...result.coverage.mcpTools.uncovered.map((tool) => `- ${tool}`),
    "",
    "</details>",
    "",
    "<details>",
    "<summary>Uncovered workflow node types</summary>",
    "",
    ...result.coverage.nodeTypes.uncovered.map((type) => `- ${type}`),
    "",
    "</details>",
    "",
  );
  return lines.join("\n");
}

export async function writeReports(
  result: E2eResult,
  jsonPath: string,
  summaryPath?: string,
): Promise<void> {
  await Bun.write(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  if (summaryPath) await Bun.write(summaryPath, markdownSummary(result));
}
