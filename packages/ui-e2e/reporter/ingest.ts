import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "./cli.ts";
import {
  type ArtifactRecord,
  buildShardPayload,
  type CoverageSummary,
  type RunContext,
  type Summary,
  withCoverage,
} from "./ingest-payload.ts";
import { postPayloads } from "./ingest-post.ts";

interface Options {
  summaries: string;
  artifacts: string;
  out: string;
  reportUrl: string | undefined;
  coverage: string | undefined;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const values = parseFlags(argv, {
    required: ["summaries", "artifacts", "out"],
    optional: ["report-url", "coverage"],
    booleans: ["dry-run"],
  });
  const required = (key: string): string => {
    const value = values.get(key);
    if (typeof value !== "string" || !value) throw new Error(`Missing required argument --${key}`);
    return value;
  };
  return {
    summaries: required("summaries"),
    artifacts: required("artifacts"),
    out: required("out"),
    reportUrl: values.get("report-url") as string | undefined,
    coverage: values.get("coverage") as string | undefined,
    dryRun: values.get("dry-run") === true,
  };
}

function findSummaryFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...findSummaryFiles(path));
    else if (entry.isFile() && entry.name === "summary.json") files.push(path);
  }
  return files.sort();
}

// A missing file is the normal case for a run without agent-fs secrets. A file that exists but
// cannot be read is a publisher bug, so it is logged instead of swallowed.
function readArtifacts(path: string): ArtifactRecord[] {
  if (!existsSync(path)) return [];
  try {
    const artifacts = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (Array.isArray(artifacts)) return artifacts as ArtifactRecord[];
    console.warn(`Ignoring ${path}: expected a JSON array`);
  } catch (error) {
    console.warn(`Ignoring unreadable ${path}: ${String(error)}`);
  }
  return [];
}

// Coverage is optional: a missing or unreadable file sends the v1 payloads unchanged.
function readCoverage(path: string | undefined): CoverageSummary | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const coverage = JSON.parse(readFileSync(path, "utf8")) as CoverageSummary;
    if (coverage.total?.total > 0 && Array.isArray(coverage.files)) return coverage;
    console.warn(`Ignoring ${path}: no coverage totals`);
  } catch (error) {
    console.warn(`Ignoring unreadable ${path}: ${String(error)}`);
  }
  return undefined;
}

function runContext(): RunContext {
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const prNumber = process.env.UI_E2E_PR_NUMBER;
  const serverUrl = process.env.GITHUB_SERVER_URL;
  const runId = process.env.GITHUB_RUN_ID;
  return {
    repo,
    ref: process.env.UI_E2E_REF ?? "",
    sha: process.env.UI_E2E_SHA ?? "",
    prNumber: prNumber ? Number(prNumber) : null,
    trigger: (process.env.UI_E2E_TRIGGER ?? "") as RunContext["trigger"],
    runner: "ci",
    ...(serverUrl && runId ? { ciUrl: `${serverUrl}/${repo}/actions/runs/${runId}` } : {}),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!statSync(options.summaries).isDirectory()) {
    throw new Error(`${options.summaries} is not a directory`);
  }
  const artifacts = readArtifacts(options.artifacts);
  const run = runContext();
  const shardPayloads = findSummaryFiles(options.summaries).map((path) =>
    buildShardPayload(
      JSON.parse(readFileSync(path, "utf8")) as Summary,
      artifacts,
      run,
      options.reportUrl,
    ),
  );
  const coverage = readCoverage(options.coverage);
  const payloads = coverage ? withCoverage(shardPayloads, coverage) : shardPayloads;

  mkdirSync(options.out, { recursive: true });
  for (const payload of payloads) {
    writeFileSync(
      join(options.out, `shard-${payload.run.shardIndex}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }

  if (options.dryRun) return;
  const url = process.env.UI_E2E_INGEST_URL;
  const bearer = process.env.UI_E2E_INGEST_BEARER;
  if (!url || !bearer) {
    console.log("ingest skipped: UI_E2E_INGEST_URL or UI_E2E_INGEST_BEARER is not set");
    return;
  }
  if (!(await postPayloads(payloads, url, bearer, { delaysMs: retryDelays() }))) {
    process.exitCode = 1;
  }
}

// Comma-separated waits in ms, e.g. "0,0". Unset keeps the default backoff.
function retryDelays(): number[] | undefined {
  const raw = process.env.UI_E2E_INGEST_RETRY_DELAYS_MS;
  if (!raw) return undefined;
  const delays = raw.split(",").map((value) => Number(value.trim()));
  if (delays.some((delay) => !Number.isFinite(delay) || delay < 0)) {
    throw new Error(`Invalid UI_E2E_INGEST_RETRY_DELAYS_MS: ${raw}`);
  }
  return delays;
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
