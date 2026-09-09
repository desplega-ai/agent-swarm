import type { Coverage } from "./coverage";

export class SkipError extends Error {}

export type RunStatus = "pass" | "fail" | "skip";
export type ScenarioResult = {
  name: string;
  status: RunStatus;
  durationMs: number;
  error?: string;
};
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
export type HarnessFailureKind = "setup" | "timeout" | "credential" | "task";
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

export type E2eResult = {
  startedAt: string;
  durationMs: number;
  sut: { port: number; dbPath: string; logPath: string };
  scenarios: ScenarioResult[];
  harness: HarnessResult[];
  coverage: Coverage;
  gates: { minRouteCoverage: number; minToolCoverage: number; passed: boolean };
  ok: boolean;
};

export type Options = {
  harness: string[];
  harnessAttempts: number;
  only?: Set<string>;
  skip: Set<string>;
  list: boolean;
  help: boolean;
  jsonPath: string;
  summaryPath?: string;
  keep: boolean;
  minRouteCoverage: number;
  minToolCoverage: number;
  sutEnv: Record<string, string>;
  visualsDir?: string;
};

export const helpText = `Usage: bun run e2e [options]

Options:
  --harness p1,p2               Run real harness legs after the contract scenarios
                                (claude, codex, pi, opencode)
  --harness-attempts N          Run a failed harness leg again, N attempts in total
                                (1 through 5, default: 1)
  --only name,name              Run only named contract scenarios
  --skip name,name              Skip named contract scenarios
  --list                        Print contract scenario names and exit
  --json path                   JSON result path (default: ./e2e-results.json)
  --summary-md path             Optional Markdown summary path
  --sut-env KEY=VALUE           Set a SUT environment variable (repeatable)
  --visuals dir                 Write a Slack journal and visual manifest
  --keep                        Keep the database, logs, and temporary directories
  --min-route-coverage N        Minimum route coverage percent (default: 0)
  --min-tool-coverage N         Minimum MCP tool coverage percent (default: 0)
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

export function parseOptions(args: string[], scenarioNames: string[]): Options {
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
    sutEnv: {},
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    const value = () => optionValue(args, index++, arg);
    if (arg === "--harness") options.harness = listValue(value());
    else if (arg === "--harness-attempts") options.harnessAttempts = attemptsValue(value());
    else if (arg === "--only") options.only = new Set(listValue(value()));
    else if (arg === "--skip") options.skip = new Set(listValue(value()));
    else if (arg === "--json") options.jsonPath = value();
    else if (arg === "--summary-md") options.summaryPath = value();
    else if (arg === "--sut-env") {
      const [key, envValue] = sutEnvValue(value());
      options.sutEnv[key] = envValue;
    } else if (arg === "--visuals") options.visualsDir = value();
    else if (arg === "--min-route-coverage") options.minRouteCoverage = coverageValue(value(), arg);
    else if (arg === "--min-tool-coverage") options.minToolCoverage = coverageValue(value(), arg);
    else if (arg === "--list") options.list = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--keep") options.keep = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  const names = new Set(scenarioNames);
  for (const name of [...(options.only ?? []), ...options.skip]) {
    if (!names.has(name)) throw new Error(`Unknown scenario: ${name}`);
  }
  for (const provider of options.harness) {
    if (!["claude", "codex", "pi", "opencode"].includes(provider)) {
      throw new Error(`Unknown harness provider: ${provider}`);
    }
  }
  return options;
}

const colors = process.stdout.isTTY
  ? { pass: "\x1b[32m", fail: "\x1b[31m", skip: "\x1b[33m", reset: "\x1b[0m" }
  : { pass: "", fail: "", skip: "", reset: "" };

export function seconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function printScenario(result: ScenarioResult): void {
  const label = result.status.toUpperCase();
  const detail = result.error ? `: ${result.error}` : "";
  const duration = result.status === "skip" ? "" : ` (${seconds(result.durationMs)})`;
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

export function printHarness(result: HarnessResult): void {
  const color = colors[result.status];
  const detail = result.error ? `: ${result.error}` : "";
  const attempts = result.attempts.length > 1 ? `, ${result.attempts.length} attempts` : "";
  const cost = result.cost ? `, ${costCell(result.cost)}` : "";
  console.log(
    `${color}${result.status.toUpperCase()}${colors.reset} harness ${result.provider} ` +
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
      return `| ${leg.provider} | ${markdownCell(leg.model)} | ${leg.status.toUpperCase()} | ${leg.attempts.length} | ${seconds(leg.durationMs)} | ${costCell(leg.cost)} | ${tokens} | ${markdownCell(leg.error ?? "")} |`;
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
        `<summary>${leg.provider} attempt ${index + 1}: ${markdownCell(attempt.error ?? "failed")}${attempt.failureKind ? ` (${attempt.failureKind})` : ""}</summary>`,
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

export function markdownSummary(result: E2eResult): string {
  const lines = [
    "## Black-box E2E",
    "",
    `Overall: **${result.ok ? "PASS" : "FAIL"}**`,
    "",
    "### Scenarios",
    "",
    "| Scenario | Status | Duration | Error |",
    "| --- | --- | ---: | --- |",
    ...result.scenarios.map(
      (scenario) =>
        `| ${scenario.name} | ${scenario.status.toUpperCase()} | ${seconds(scenario.durationMs)} | ${markdownCell(scenario.error ?? "")} |`,
    ),
  ];
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
  lines.push(
    "",
    "### Coverage",
    "",
    `routes: ${result.coverage.routes.covered}/${result.coverage.routes.total} (${result.coverage.routes.percent.toFixed(1)}%)`,
    "",
    `mcp tools: ${result.coverage.mcpTools.covered}/${result.coverage.mcpTools.total} (${result.coverage.mcpTools.percent.toFixed(1)}%)`,
    "",
    `coverage gates: ${result.gates.passed ? "PASS" : "FAIL"} (routes >= ${result.gates.minRouteCoverage}%, MCP tools >= ${result.gates.minToolCoverage}%)`,
    "",
    "| Group | Covered | Total |",
    "| --- | ---: | ---: |",
    ...Object.entries(result.coverage.routes.byGroup)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([group, counts]) => `| ${group} | ${counts.covered} | ${counts.total} |`),
    "",
    "<details>",
    "<summary>Uncovered routes</summary>",
    "",
    ...result.coverage.routes.uncovered.map((route) => `- ${route}`),
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
