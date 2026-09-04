/**
 * Merges the per-job results of the Nightly E2E workflow into one report.
 *
 * Inputs are the downloaded artifacts: one `e2e-results.json` per job under
 * `--results`, plus earlier `nightly-report.json` files under `--previous` for
 * the cost trend. Writes a Markdown summary and a JSON report, and appends
 * `ok=<bool>` to `$GITHUB_OUTPUT` when that file is set.
 *
 *   bun scripts/e2e/nightly-report.ts --results results --previous previous \
 *     --out summary.md --issue-out issue.md --json nightly-report.json --run-url URL --sha SHA
 *
 * `--issue-out` writes the same summary without worker-log tails, for the public issue.
 */
import { parseArgs } from "node:util";
import type { E2eResult, HarnessResult, ScenarioResult } from "./report";
import { harnessFailureDetails, harnessTable, markdownCell, usd } from "./report";

export const DEFAULT_PROVIDERS = ["claude", "codex", "pi", "opencode"];
const TREND_LIMIT = 14;

export type ContractSummary = {
  ok: boolean;
  scenarios: ScenarioResult[];
  coverage: E2eResult["coverage"];
  gates: E2eResult["gates"];
};

export type NightlyReport = {
  version: 1;
  generatedAt: string;
  runId: string;
  runUrl: string;
  sha: string;
  ok: boolean;
  /** Null when the contract job produced no result file. */
  contract: ContractSummary | null;
  harness: HarnessResult[];
  /** Providers with no result file, such as a leg that died before writing one. */
  missingLegs: string[];
  /** USD over every leg and attempt in this run. */
  totalCostUsd: number;
  warnings: string[];
};

export type ReportInputs = {
  results: E2eResult[];
  previous: NightlyReport[];
  providers: string[];
  runId: string;
  runUrl: string;
  sha: string;
  generatedAt: string;
  credentialWarnDays: number;
};

function normalizeLeg(leg: HarnessResult): HarnessResult {
  return {
    ...leg,
    attempts: leg.attempts ?? [
      { status: leg.status, durationMs: leg.durationMs, error: leg.error, cost: leg.cost },
    ],
    totalCostUsd: leg.totalCostUsd ?? leg.cost?.totalUsd ?? 0,
  };
}

function daysUntil(iso: string, now: string): number {
  return (new Date(iso).getTime() - new Date(now).getTime()) / 86_400_000;
}

export function buildNightlyReport(inputs: ReportInputs): NightlyReport {
  const contractResult = inputs.results.find((result) => result.harness.length === 0);
  const contract: ContractSummary | null = contractResult
    ? {
        ok: contractResult.ok,
        scenarios: contractResult.scenarios,
        coverage: contractResult.coverage,
        gates: contractResult.gates,
      }
    : null;
  const legs = new Map<string, HarnessResult>();
  for (const result of inputs.results) {
    for (const leg of result.harness) legs.set(leg.provider, normalizeLeg(leg));
  }
  const harness = inputs.providers
    .filter((provider) => legs.has(provider))
    .map((provider) => legs.get(provider)!);
  const missingLegs = inputs.providers.filter((provider) => !legs.has(provider));

  const warnings: string[] = [];
  if (!contract) warnings.push("The contract job produced no result file.");
  else if (!contract.gates.passed) warnings.push("Coverage gates failed in the contract job.");
  for (const provider of missingLegs) warnings.push(`${provider}: no result file from the leg.`);
  for (const leg of harness) {
    if (leg.attempts.length > 1) {
      warnings.push(`${leg.provider}: needed ${leg.attempts.length} attempts.`);
    }
    if (leg.status === "pass" && leg.cost && leg.cost.records === 0) {
      warnings.push(`${leg.provider}: the task passed but the API stored no cost record.`);
    }
    if (leg.credentialExpiresAt) {
      const days = daysUntil(leg.credentialExpiresAt, inputs.generatedAt);
      if (days < 0) {
        warnings.push(
          `${leg.provider}: the seeded OAuth access token expired on ${leg.credentialExpiresAt.slice(0, 10)}. Re-seed the secret before the refresh token rotates.`,
        );
      } else if (days <= inputs.credentialWarnDays) {
        warnings.push(
          `${leg.provider}: the seeded OAuth access token expires in ${days.toFixed(1)} days (${leg.credentialExpiresAt.slice(0, 10)}). Re-seed the secret.`,
        );
      }
    }
  }

  const ok =
    contract?.ok === true &&
    missingLegs.length === 0 &&
    harness.every((leg) => leg.status === "pass");
  return {
    version: 1,
    generatedAt: inputs.generatedAt,
    runId: inputs.runId,
    runUrl: inputs.runUrl,
    sha: inputs.sha,
    ok,
    contract,
    harness,
    missingLegs,
    totalCostUsd: harness.reduce((total, leg) => total + leg.totalCostUsd, 0),
    warnings,
  };
}

function trendRows(current: NightlyReport, previous: NightlyReport[], providers: string[]) {
  const runs = [current, ...previous]
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    .slice(0, TREND_LIMIT);
  return runs.map((run) => {
    const cells = providers.map((provider) => {
      const leg = run.harness.find((candidate) => candidate.provider === provider);
      if (!leg) return "-";
      if (leg.status === "fail") return `fail (${usd(leg.totalCostUsd)})`;
      return leg.cost?.records ? usd(leg.totalCostUsd) : "no record";
    });
    const label = run.runUrl
      ? `[${run.generatedAt.slice(0, 10)}](${run.runUrl})`
      : run.generatedAt.slice(0, 10);
    return `| ${label} | ${run.ok ? "PASS" : "FAIL"} | ${cells.join(" | ")} | ${usd(run.totalCostUsd)} |`;
  });
}

export type MarkdownOptions = {
  /** Include the worker-log tails of failed attempts. Off for the public sticky issue. */
  logTails: boolean;
};

export function nightlyMarkdown(
  report: NightlyReport,
  previous: NightlyReport[],
  providers: string[],
  options: MarkdownOptions = { logTails: true },
): string {
  const passedLegs = report.harness.filter((leg) => leg.status === "pass").length;
  const shaLabel = report.sha ? `\`${report.sha.slice(0, 7)}\`` : "";
  const runLabel = report.runUrl ? `[run](${report.runUrl})` : "";
  const headline = [
    shaLabel,
    runLabel,
    `${passedLegs}/${providers.length} harness legs passed`,
    `total cost ${usd(report.totalCostUsd)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const lines = [
    `## Nightly E2E: ${report.ok ? "PASS" : "FAIL"}`,
    "",
    headline,
    "",
    "### Harness legs",
    "",
    ...harnessTable(report.harness),
    ...report.missingLegs.map((provider) => `| ${provider} | | MISSING | | | | | no result file |`),
    "",
  ];

  lines.push("### Contract scenarios", "");
  if (report.contract) {
    const { scenarios, coverage, gates } = report.contract;
    const count = (status: string) => scenarios.filter((s) => s.status === status).length;
    lines.push(
      `${count("pass")} passed, ${count("fail")} failed, ${count("skip")} skipped · ` +
        `routes ${coverage.routes.covered}/${coverage.routes.total} (${coverage.routes.percent.toFixed(1)}%) · ` +
        `MCP tools ${coverage.mcpTools.covered}/${coverage.mcpTools.total} (${coverage.mcpTools.percent.toFixed(1)}%) · ` +
        `gates ${gates.passed ? "PASS" : "FAIL"}`,
      "",
    );
    const notPassed = scenarios.filter((scenario) => scenario.status !== "pass");
    if (notPassed.length > 0) {
      lines.push(
        "| Scenario | Status | Error |",
        "| --- | --- | --- |",
        ...notPassed.map(
          (scenario) =>
            `| ${scenario.name} | ${scenario.status.toUpperCase()} | ${markdownCell(scenario.error ?? "")} |`,
        ),
        "",
      );
    }
  } else {
    lines.push("No result file from the contract job.", "");
  }

  if (report.warnings.length > 0) {
    lines.push("### Warnings", "", ...report.warnings.map((warning) => `- ${warning}`), "");
  }

  lines.push(
    "<details>",
    `<summary>Cost per run, newest first (up to ${TREND_LIMIT})</summary>`,
    "",
    `| Run | Status | ${providers.join(" | ")} | Total |`,
    `| --- | --- | ${providers.map(() => "---:").join(" | ")} | ---: |`,
    ...trendRows(report, previous, providers),
    "",
    "</details>",
    "",
  );
  if (options.logTails) lines.push(...harnessFailureDetails(report.harness));
  else if (report.harness.some((leg) => leg.attempts.some((a) => a.status === "fail"))) {
    lines.push(
      `Worker log tails for the failed attempts are in the [run summary](${report.runUrl}).`,
      "",
    );
  }
  return lines.join("\n");
}

async function readJsonFiles<T>(dir: string, pattern: string): Promise<T[]> {
  const files: T[] = [];
  const glob = new Bun.Glob(pattern);
  const paths = [...glob.scanSync({ cwd: dir })].sort();
  for (const path of paths) {
    try {
      files.push((await Bun.file(`${dir}/${path}`).json()) as T);
    } catch (error) {
      console.warn(`Skipping unreadable ${dir}/${path}: ${String(error)}`);
    }
  }
  return files;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      results: { type: "string" },
      previous: { type: "string" },
      out: { type: "string", default: "nightly-summary.md" },
      "issue-out": { type: "string" },
      json: { type: "string", default: "nightly-report.json" },
      "run-id": { type: "string", default: process.env.GITHUB_RUN_ID ?? "" },
      "run-url": { type: "string", default: "" },
      sha: { type: "string", default: process.env.GITHUB_SHA ?? "" },
      providers: { type: "string", default: DEFAULT_PROVIDERS.join(",") },
      "credential-warn-days": { type: "string", default: "3" },
    },
  });
  if (!values.results) throw new Error("--results is required");
  const providers = values.providers
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const results = await readJsonFiles<E2eResult>(values.results, "**/e2e-results.json");
  const previous = values.previous
    ? await readJsonFiles<NightlyReport>(values.previous, "**/nightly-report.json")
    : [];
  const report = buildNightlyReport({
    results,
    previous: previous.filter((run) => run.runId !== values["run-id"]),
    providers,
    runId: values["run-id"],
    runUrl: values["run-url"],
    sha: values.sha,
    generatedAt: new Date().toISOString(),
    credentialWarnDays: Number(values["credential-warn-days"]),
  });
  const markdown = nightlyMarkdown(report, previous, providers);
  await Bun.write(values.out, markdown);
  if (values["issue-out"]) {
    await Bun.write(
      values["issue-out"],
      nightlyMarkdown(report, previous, providers, { logTails: false }),
    );
  }
  await Bun.write(values.json, `${JSON.stringify(report, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    await Bun.write(
      Bun.file(process.env.GITHUB_OUTPUT),
      `${await Bun.file(process.env.GITHUB_OUTPUT)
        .text()
        .catch(() => "")}ok=${report.ok}\n`,
    );
  }
  console.log(markdown);
  console.log(`ok=${report.ok}`);
}

if (import.meta.main) {
  await main();
}
