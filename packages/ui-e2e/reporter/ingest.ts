import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "./cli.ts";
import {
  type ArtifactRecord,
  buildShardPayload,
  type IngestPayload,
  type RunContext,
  type Summary,
} from "./ingest-payload.ts";

interface Options {
  summaries: string;
  artifacts: string;
  out: string;
  reportUrl: string | undefined;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const values = parseFlags(argv, {
    required: ["summaries", "artifacts", "out"],
    optional: ["report-url"],
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

function redact(value: string, bearer: string): string {
  return value.replaceAll(bearer, "[redacted]");
}

function compact(value: unknown, bearer: string): string {
  return redact(JSON.stringify(value), bearer).slice(0, 500);
}

function responseDetails(body: unknown, bearer: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if ("result" in record) return compact(record.result, bearer);
  const error = record.error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return redact(message, bearer).slice(0, 500);
  }
  return undefined;
}

async function postPayloads(
  payloads: IngestPayload[],
  url: string,
  bearer: string,
): Promise<boolean> {
  const host = new URL(url).host;
  console.log(`ingest host: ${host}`);
  let succeeded = true;

  for (const payload of payloads) {
    let status = 0;
    let body: unknown;
    let durationMs = 0;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
          "X-Swarm-Timeout-Ms": "180000",
        },
        body: JSON.stringify(payload),
      });
      status = response.status;
      body = await response.json();
      if (typeof body === "object" && body !== null) {
        const responseBody = body as Record<string, unknown>;
        if (typeof responseBody.durationMs === "number") durationMs = responseBody.durationMs;
      }
    } catch (error) {
      body = { error: { message: error instanceof Error ? error.message : String(error) } };
    }

    const ok =
      status === 200 &&
      typeof body === "object" &&
      body !== null &&
      (body as Record<string, unknown>).ok === true;
    console.log(
      `shard ${payload.run.shardIndex}: HTTP ${status} ok=${ok} durationMs=${durationMs}`,
    );
    const details = responseDetails(body, bearer);
    if (details) console.log(details);
    if (!ok) succeeded = false;
  }

  return succeeded;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!statSync(options.summaries).isDirectory()) {
    throw new Error(`${options.summaries} is not a directory`);
  }
  const artifacts = readArtifacts(options.artifacts);
  const run = runContext();
  const payloads = findSummaryFiles(options.summaries).map((path) =>
    buildShardPayload(
      JSON.parse(readFileSync(path, "utf8")) as Summary,
      artifacts,
      run,
      options.reportUrl,
    ),
  );

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
  if (!(await postPayloads(payloads, url, bearer))) process.exitCode = 1;
}

main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
