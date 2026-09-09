import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type ArtifactRecord,
  buildShardPayload,
  type RunContext,
  type Summary,
  triggerFor,
} from "../../packages/ui-e2e/reporter/ingest-payload.ts";
import { validateJsonSchema } from "../workflows/json-schema-validator";

const schema = JSON.parse(
  readFileSync("packages/ui-e2e/reporter/ui-e2e-ingest.v1.schema.json", "utf8"),
) as Record<string, unknown>;

const run: RunContext = {
  repo: "desplega-ai/agent-swarm",
  ref: "ui-e2e-p2",
  sha: "0123456789abcdef0123456789abcdef01234567",
  prNumber: 123,
  trigger: "pr",
  runner: "ci",
  ciUrl: "https://github.com/desplega-ai/agent-swarm/actions/runs/123",
};

const summary: Summary = {
  shard: { current: 1, total: 2 },
  startedAt: "2026-09-07T10:00:00.000Z",
  finishedAt: "2026-09-07T10:01:00.000Z",
  results: [
    {
      specId:
        "chromium > specs/tasks.spec.ts > below the lg breakpoint > session logs open from the Session Logs tab",
      titlePath: ["below the lg breakpoint", "session logs open from the Session Logs tab"],
      title: "session logs open from the Session Logs tab",
      file: "specs/tasks.spec.ts",
      status: "failed",
      durationMs: 200,
      retry: 0,
      error: "first attempt failed",
    },
    {
      specId:
        "chromium > specs/tasks.spec.ts > below the lg breakpoint > session logs open from the Session Logs tab",
      titlePath: ["below the lg breakpoint", "session logs open from the Session Logs tab"],
      title: "session logs open from the Session Logs tab",
      file: "specs/tasks.spec.ts",
      status: "passed",
      durationMs: 100,
      retry: 1,
    },
    {
      specId: "chromium > specs/timed-out.spec.ts > times out",
      titlePath: ["times out"],
      title: "times out",
      file: "specs/timed-out.spec.ts",
      status: "timedOut",
      durationMs: 300,
      retry: 0,
      error: "Timed out after 300 ms",
    },
    {
      specId: "chromium > specs/skipped.spec.ts > skips",
      titlePath: ["skips"],
      title: "skips",
      file: "specs/skipped.spec.ts",
      status: "skipped",
      durationMs: 0,
      retry: 0,
    },
  ],
};

const artifacts: ArtifactRecord[] = [
  {
    kind: "screenshot",
    path: "e2e/desplega-ai__agent-swarm/pr-123/sha/1/failure.png",
    orgId: "org-1",
    driveId: "drive-1",
    specId:
      "specs/tasks.spec.ts:below the lg breakpoint > session logs open from the Session Logs tab",
    sizeBytes: 123,
    shardIndex: 1,
  },
  {
    kind: "trace",
    path: "e2e/desplega-ai__agent-swarm/pr-123/sha/2/trace.zip",
    orgId: "org-1",
    driveId: "drive-1",
    specId: null,
    sizeBytes: 456,
    shardIndex: 2,
  },
];

function propertyKeys(path: string[]): string[] {
  let current: unknown = schema;
  for (const key of path) {
    current = (current as Record<string, unknown>)[key];
  }
  return Object.keys((current as { properties: Record<string, unknown> }).properties).sort();
}

function expectSchemaKeys(actual: object, path: string[], required: string[]): void {
  const actualKeys = Object.keys(actual).sort();
  expect(actualKeys).toEqual(required.slice().sort());
  expect(actualKeys.every((key) => propertyKeys(path).includes(key))).toBe(true);
}

test("buildShardPayload creates a schema-valid tracker payload", () => {
  const payload = buildShardPayload(
    summary,
    artifacts,
    run,
    "https://github.com/desplega-ai/agent-swarm/actions/runs/123/artifacts/456",
  );

  expect(validateJsonSchema(schema, payload)).toEqual([]);
  expectSchemaKeys(payload, [], ["schemaVersion", "run", "results", "artifacts"]);
  expectSchemaKeys(
    payload.run,
    ["properties", "run"],
    [
      "repo",
      "ref",
      "sha",
      "prNumber",
      "isFork",
      "trigger",
      "runner",
      "shardIndex",
      "shardTotal",
      "startedAt",
      "finishedAt",
      "ciUrl",
    ],
  );
  expect(payload.run.sha).toMatch(/^[0-9a-f]{7,40}$/);
  expect(payload.results).toHaveLength(3);

  const flaky = payload.results.find(
    (result) =>
      result.specId ===
      "specs/tasks.spec.ts:below the lg breakpoint > session logs open from the Session Logs tab",
  );
  expect(flaky).toMatchObject({ status: "flaky", retries: 1 });
  if (!flaky) throw new Error("Expected flaky result");
  expectSchemaKeys(
    flaky,
    ["properties", "results", "items"],
    ["specId", "title", "status", "durationMs", "retries"],
  );

  const timedOut = payload.results.find(
    (result) => result.specId === "specs/timed-out.spec.ts:times out",
  );
  expect(timedOut).toMatchObject({ status: "failed", error: "Timed out after 300 ms" });
  const skipped = payload.results.find((result) => result.specId === "specs/skipped.spec.ts:skips");
  expect(skipped).toMatchObject({ status: "skipped" });

  expect(payload.artifacts).toHaveLength(2);
  expectSchemaKeys(
    payload.artifacts[0] ?? {},
    ["properties", "artifacts", "items"],
    ["kind", "storage", "path", "orgId", "driveId", "specId", "sizeBytes"],
  );
  expectSchemaKeys(
    payload.artifacts[1] ?? {},
    ["properties", "artifacts", "items"],
    ["kind", "storage", "url"],
  );
  expect(payload.artifacts.filter((artifact) => artifact.kind === "report")).toHaveLength(1);
  expect(payload.artifacts.some((artifact) => artifact.kind === "trace")).toBe(false);
});

test("buildShardPayload supports summaries without titlePath", () => {
  const oldSummary: Summary = {
    ...summary,
    shard: null,
    results: [
      {
        specId: "chromium > specs/legacy.spec.ts > suite > works",
        title: "works",
        file: "specs/legacy.spec.ts",
        status: "passed",
        durationMs: 1,
        retry: 0,
      },
    ],
  };

  const payload = buildShardPayload(oldSummary, [], { ...run, trigger: "manual" });
  expect(payload.run).toMatchObject({ shardIndex: 1, shardTotal: 1 });
  expect(payload.results[0]?.specId).toBe("specs/legacy.spec.ts:suite > works");
});

test("triggerFor maps GitHub events", () => {
  expect(triggerFor("pull_request")).toBe("pr");
  expect(triggerFor("push")).toBe("main");
  expect(triggerFor("schedule")).toBe("nightly");
  expect(triggerFor("workflow_dispatch")).toBe("manual");
  expect(triggerFor("other")).toBe("manual");
});

test("buildShardPayload rejects invalid run identity", () => {
  expect(() => buildShardPayload(summary, [], { ...run, sha: "ABC" })).toThrow(
    "UI_E2E_SHA must be 7 to 40 lowercase hex characters",
  );
  expect(() => buildShardPayload(summary, [], { ...run, repo: "agent-swarm" })).toThrow(
    "GITHUB_REPOSITORY must contain exactly one slash",
  );
  expect(() => buildShardPayload(summary, [], { ...run, trigger: "bad" as "pr" })).toThrow(
    "Unknown UI E2E trigger: bad",
  );
});

test("buildShardPayload omits empty org and drive ids so the tracker fallback applies", () => {
  const payload = buildShardPayload(
    summary,
    [{ ...artifacts[0]!, orgId: "", driveId: undefined }],
    run,
  );
  const artifact = payload.artifacts[0] as Record<string, unknown>;
  expect(artifact.storage).toBe("agent-fs");
  expect("orgId" in artifact).toBe(false);
  expect("driveId" in artifact).toBe(false);
  expect(validateJsonSchema(schema, payload)).toEqual([]);
});

test("buildShardPayload fills in error text for a failed result without one", () => {
  const silent: Summary = {
    ...summary,
    results: [
      {
        specId: "chromium > specs/silent.spec.ts > dies quietly",
        titlePath: ["dies quietly"],
        title: "dies quietly",
        file: "specs/silent.spec.ts",
        status: "interrupted",
        durationMs: 10,
        retry: 0,
      },
    ],
  };
  const payload = buildShardPayload(silent, [], run);
  expect(payload.results).toEqual([
    {
      specId: "specs/silent.spec.ts:dies quietly",
      title: "dies quietly",
      status: "failed",
      durationMs: 10,
      retries: 0,
      error: "interrupted without error text",
    },
  ]);
  expect(validateJsonSchema(schema, payload)).toEqual([]);
});
