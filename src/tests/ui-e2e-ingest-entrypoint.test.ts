import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, runChild } from "./test-proc.ts";

// Runs the reporter entrypoint as CI does, against a fake ingest endpoint. It imports nothing
// from the reporter, so it exercises whatever `ingest.ts` does on the checked-out ref.
const ENTRYPOINT = join(import.meta.dir, "../../packages/ui-e2e/reporter/ingest.ts");

// 502: an HTML gateway error. "reset": the script lost its API connection (HTTP 200, ok=false).
type Reply = 200 | 502 | "reset";
let replies: Reply[] = [];
let received: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let workDir: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push(await req.text());
      const reply = replies.shift() ?? 200;
      if (reply === 502) return new Response("<html>502 Bad Gateway</html>", { status: 502 });
      if (reply === "reset") {
        return Response.json({
          ok: false,
          result: null,
          error: { type: "runtime_error", message: "TypeError: ECONNRESET: socket hang up" },
          durationMs: 1,
        });
      }
      return Response.json({ ok: true, result: { runKey: "k" }, durationMs: 1 });
    },
  });
  workDir = mkdtempSync(join(tmpdir(), "ui-e2e-ingest-entrypoint-"));
  writeFileSync(
    join(workDir, "summary.json"),
    JSON.stringify({
      shard: { current: 1, total: 1 },
      startedAt: "2026-10-27T15:00:00.000Z",
      finishedAt: "2026-10-27T15:01:00.000Z",
      results: [
        {
          specId: "spec-0",
          title: "spec 0",
          file: "spec.ts",
          status: "passed",
          durationMs: 10,
          retry: 0,
        },
      ],
    }),
  );
});

afterAll(() => {
  server.stop(true);
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  replies = [];
  received = [];
});

function runReporter() {
  return runChild(
    [
      process.execPath,
      ENTRYPOINT,
      "--summaries",
      workDir,
      "--artifacts",
      join(workDir, "missing-artifacts.json"),
      "--out",
      join(workDir, "out"),
    ],
    {
      env: {
        PATH: process.env.PATH,
        UI_E2E_INGEST_URL: `http://127.0.0.1:${server.port}/api/x/script/endpoint`,
        UI_E2E_INGEST_BEARER: "secret",
        UI_E2E_INGEST_RETRY_DELAYS_MS: "0,0",
        UI_E2E_REF: "main",
        UI_E2E_SHA: "0123456789abcdef0123456789abcdef01234567",
        UI_E2E_TRIGGER: "main",
        GITHUB_REPOSITORY: "desplega-ai/agent-swarm",
      },
    },
  );
}

test(
  "the reporter retries a 502 and exits 0",
  async () => {
    replies = [502, 200];
    const result = await runReporter();
    expect(result.stderr).toBe("");
    expect(received).toHaveLength(2);
    expect(received[1]).toBe(received[0]);
    expect(result.exitCode).toBe(0);
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

test(
  "the reporter retries a transport ok=false and exits 0",
  async () => {
    replies = ["reset", 200];
    const result = await runReporter();
    expect(received).toHaveLength(2);
    expect(result.exitCode).toBe(0);
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);

test(
  "the reporter exits 1 once retries are exhausted",
  async () => {
    replies = [502, 502, 502];
    const result = await runReporter();
    expect(received).toHaveLength(3);
    expect(result.exitCode).toBe(1);
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
