export interface SummaryResult {
  specId: string;
  titlePath?: string[];
  title: string;
  file: string;
  status: string;
  durationMs: number;
  retry: number;
  error?: string;
}

export interface Summary {
  shard: { current: number; total: number } | null;
  startedAt: string;
  finishedAt: string;
  results: SummaryResult[];
}

export interface RunContext {
  repo: string;
  ref: string;
  sha: string;
  prNumber: number | null;
  trigger: "pr" | "main" | "nightly" | "manual";
  runner: "ci";
  ciUrl?: string;
}

export interface ArtifactRecord {
  kind: "screenshot" | "trace" | "video" | "report" | "log";
  path: string;
  orgId: string;
  driveId: string;
  specId: string | null;
  sizeBytes: number;
  shardIndex: number;
}

export interface IngestPayload {
  schemaVersion: 1;
  run: RunContext & {
    isFork: false;
    shardIndex: number;
    shardTotal: number;
    startedAt: string;
    finishedAt: string;
  };
  results: Array<{
    specId: string;
    title: string;
    status: "passed" | "failed" | "skipped" | "flaky";
    durationMs: number;
    retries: number;
    error?: string;
  }>;
  artifacts: Array<
    | {
        kind: ArtifactRecord["kind"];
        storage: "agent-fs";
        path: string;
        orgId: string;
        driveId: string;
        specId: string | null;
        sizeBytes: number;
      }
    | { kind: "report"; storage: "github"; url: string }
  >;
}

const SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const TRIGGERS = new Set(["pr", "main", "nightly", "manual"]);

function titlePathFor(result: SummaryResult): string[] {
  if (result.titlePath) return result.titlePath;
  return result.specId.split(" > ").slice(2);
}

function trackerStatus(status: string, retries: number): "passed" | "failed" | "skipped" | "flaky" {
  if (status === "passed") return retries > 0 ? "flaky" : "passed";
  if (status === "skipped") return "skipped";
  return "failed";
}

function validateRun(run: RunContext): void {
  if (!SHA_PATTERN.test(run.sha))
    throw new Error("UI_E2E_SHA must be 7 to 40 lowercase hex characters");
  const parts = run.repo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("GITHUB_REPOSITORY must contain exactly one slash");
  }
  if (!TRIGGERS.has(run.trigger)) throw new Error(`Unknown UI E2E trigger: ${run.trigger}`);
}

export function triggerFor(eventName: string): RunContext["trigger"] {
  if (eventName === "pull_request") return "pr";
  if (eventName === "push") return "main";
  if (eventName === "schedule") return "nightly";
  return "manual";
}

export function buildShardPayload(
  summary: Summary,
  artifacts: ArtifactRecord[],
  run: RunContext,
  reportArtifactUrl?: string,
): IngestPayload {
  validateRun(run);
  const shardIndex = summary.shard?.current ?? 1;
  const shardTotal = summary.shard?.total ?? 1;
  const bySpec = new Map<string, { result: SummaryResult; retries: number }>();

  for (const result of summary.results) {
    const specId = `${result.file}:${titlePathFor(result).join(" > ")}`;
    const previous = bySpec.get(specId);
    bySpec.set(specId, {
      result,
      retries: Math.max(previous?.retries ?? 0, result.retry),
    });
  }

  const results = [...bySpec.entries()]
    .map(([specId, { result, retries }]) => {
      const status = trackerStatus(result.status, retries);
      const error =
        result.error || (status === "failed" ? `${result.status} without error text` : undefined);
      return {
        specId,
        title: result.title,
        status,
        durationMs: result.durationMs,
        retries,
        ...(error ? { error } : {}),
      };
    })
    .sort((left, right) => left.specId.localeCompare(right.specId));

  const payloadArtifacts: IngestPayload["artifacts"] = artifacts
    .filter((artifact) => artifact.shardIndex === shardIndex)
    .map((artifact) => ({
      kind: artifact.kind,
      storage: "agent-fs" as const,
      path: artifact.path,
      orgId: artifact.orgId,
      driveId: artifact.driveId,
      specId: artifact.specId,
      sizeBytes: artifact.sizeBytes,
    }));
  if (reportArtifactUrl) {
    payloadArtifacts.push({ kind: "report", storage: "github", url: reportArtifactUrl });
  }

  return {
    schemaVersion: 1,
    run: {
      ...run,
      isFork: false,
      shardIndex,
      shardTotal,
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
    },
    results,
    artifacts: payloadArtifacts,
  };
}
