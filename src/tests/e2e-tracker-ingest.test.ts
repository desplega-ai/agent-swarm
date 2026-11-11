import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLcov } from "../../scripts/e2e/diff-coverage";
import type { E2eResult, ScenarioResult } from "../../scripts/e2e/report";
import {
  buildPayloads,
  coverageBlock,
  postPayloads,
  scenarioResult,
} from "../../scripts/e2e/tracker-ingest";
import { getFreePort } from "./test-net";
import { runChild } from "./test-proc";

const RUN = {
  repo: "o/r",
  ref: "feat/x",
  sha: "a".repeat(40),
  prNumber: 7,
  trigger: "pr" as const,
  ciUrl: "https://github.com/o/r/actions/runs/1",
};

const scenario = (
  name: string,
  status: ScenarioResult["status"],
  extra: Partial<ScenarioResult> = {},
) => ({ name, status, durationMs: 1234.6, ...extra }) as ScenarioResult;

const shard = (index: number, scenarios: ScenarioResult[]) =>
  ({
    startedAt: "2026-11-11T10:00:00.000Z",
    durationMs: 60_000,
    scenarios,
    shard: { index, total: 3 },
  }) as unknown as E2eResult;

describe("scenarioResult", () => {
  test("keeps the runner's status words and counts reruns as retries", () => {
    const flaky = scenarioResult(
      scenario("slack-flags", "flaky", {
        attempts: [
          { status: "fail", durationMs: 1 },
          { status: "pass", durationMs: 1 },
        ],
      }),
    );
    expect(flaky).toEqual({
      specId: "scripts/e2e/scenarios/slack-flags.ts:slack-flags",
      title: "slack-flags",
      status: "flaky",
      durationMs: 1235,
      retries: 1,
    });
    expect(scenarioResult(scenario("auth", "pass")).retries).toBe(0);
  });

  test("a failure always carries an error", () => {
    expect(scenarioResult(scenario("a", "fail")).error).toBe("failed");
    expect(scenarioResult(scenario("a", "fail", { error: "boom" })).error).toBe("boom");
    expect(scenarioResult(scenario("a", "pass")).error).toBeUndefined();
  });
});

describe("coverageBlock", () => {
  const lcov = parseLcov(
    [
      "SF:src/http/a.ts\nDA:1,1\nDA:2,0\nDA:3,5\nend_of_record",
      "SF:src/commands/worker.ts\nDA:1,1\nend_of_record", // worker code: out of scope
      "SF:src/tests/x.test.ts\nDA:1,1\nend_of_record", // a test: out of scope
      "SF:src/be/exempt.ts\nDA:1,0\nend_of_record",
    ].join("\n"),
  );

  test("sums executable and covered lines of in-scope files only", () => {
    const block = coverageBlock(lcov, ["src/be/exempt.ts"]);
    expect(block).toEqual({
      total: { covered: 2, total: 3 },
      files: [{ path: "src/http/a.ts", covered: 2, total: 3 }],
    });
  });

  test("no in-scope file means no block", () => {
    expect(coverageBlock(new Map(), [])).toBeUndefined();
  });

  test("the rule 3 result becomes ranges; an error result adds nothing", () => {
    const withPr = coverageBlock(lcov, [], {
      report: {
        changed: 4,
        covered: 1,
        files: [
          { path: "src/http/a.ts", uncovered: [2, 3, 9] },
          { path: "src/x.ts", uncovered: [] },
        ],
      },
    });
    expect(withPr?.pr).toEqual({
      changed: 4,
      covered: 1,
      uncovered: [{ path: "src/http/a.ts", ranges: "2-3, 9" }],
    });
    expect(coverageBlock(lcov, [], { report: { error: "no lcov" } })?.pr).toBeUndefined();
    expect(coverageBlock(lcov, [])?.pr).toBeUndefined();
  });
});

describe("buildPayloads", () => {
  const coverage = { total: { covered: 1, total: 2 }, files: [] };

  test("one contract payload per shard in order; the first carries coverage", () => {
    const payloads = buildPayloads(
      [shard(3, []), shard(1, [scenario("a", "pass")]), shard(2, [])],
      RUN,
      coverage,
    );
    expect(payloads.map((p) => p.run.shardIndex)).toEqual([1, 2, 3]);
    expect(payloads.map((p) => Boolean(p.coverage))).toEqual([true, false, false]);
    const first = payloads[0]!;
    expect(first.schemaVersion).toBe(2);
    expect(first.run).toMatchObject({
      suite: "contract",
      runner: "ci",
      trigger: "pr",
      prNumber: 7,
      shardTotal: 3,
      isFork: false,
      startedAt: "2026-11-11T10:00:00.000Z",
      finishedAt: "2026-11-11T10:01:00.000Z",
      ciUrl: RUN.ciUrl,
    });
    expect(first.results).toHaveLength(1);
  });

  test("a result without a shard block is dropped", () => {
    expect(buildPayloads([{ scenarios: [] } as unknown as E2eResult], RUN)).toEqual([]);
  });
});

describe("postPayloads", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  const payloads = buildPayloads([shard(1, []), shard(2, [])], RUN);

  test("posts each shard with the bearer and counts the accepted ones", async () => {
    const seen: Array<{ auth: string | null; shard: number }> = [];
    server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as { run: { shardIndex: number } };
        seen.push({ auth: request.headers.get("authorization"), shard: body.run.shardIndex });
        return Response.json({ ok: true });
      },
    });
    const accepted = await postPayloads(payloads, `http://127.0.0.1:${server.port}/`, "tok", {
      backoffMs: [0, 0],
    });
    expect(accepted).toBe(2);
    expect(seen).toEqual([
      { auth: "Bearer tok", shard: 1 },
      { auth: "Bearer tok", shard: 2 },
    ]);
  });

  test("retries a 5xx and an ok:false answer, then gives up without throwing", async () => {
    let calls = 0;
    server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        // First shard: 500, then ok:false, then accepted. Second shard: always 500.
        if (calls === 1) return new Response("down", { status: 500 });
        if (calls === 2) return Response.json({ ok: false, error: { message: "ECONNRESET" } });
        if (calls === 3) return Response.json({ ok: true });
        return new Response("down", { status: 502 });
      },
    });
    const accepted = await postPayloads(payloads, `http://127.0.0.1:${server.port}/`, "tok", {
      backoffMs: [0, 0],
    });
    expect(accepted).toBe(1);
    expect(calls).toBe(6);
  });

  test("an unreachable tracker returns without throwing", async () => {
    const port = await getFreePort();
    expect(
      await postPayloads(payloads, `http://127.0.0.1:${port}/`, "tok", { backoffMs: [0, 0] }),
    ).toBe(0);
  });

  test("past the deadline it starts no new request", async () => {
    let calls = 0;
    server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        return Response.json({ ok: true });
      },
    });
    expect(
      await postPayloads(payloads, `http://127.0.0.1:${server.port}/`, "tok", { deadlineMs: -1 }),
    ).toBe(0);
    expect(calls).toBe(0);
  });
});

describe("script entry", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("without the tracker secrets it writes the payloads and exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-tracker-"));
    dirs.push(dir);
    writeFileSync(join(dir, "e2e-shard-1.json"), JSON.stringify(shard(1, [scenario("a", "pass")])));
    const out = join(dir, "out");
    const result = await runChild(
      [
        "bun",
        "scripts/e2e/tracker-ingest.ts",
        "--shards",
        dir,
        "--lcov-dir",
        join(dir, "none"),
        "--out",
        out,
      ],
      {
        env: {
          PATH: process.env.PATH,
          GITHUB_REPOSITORY: "o/r",
          TRACKER_SHA: "a".repeat(40),
          TRACKER_REF: "main",
          TRACKER_TRIGGER: "main",
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("UI_E2E_INGEST_URL or UI_E2E_INGEST_BEARER is not set");
    const payload = await Bun.file(join(out, "shard-1.json")).json();
    expect(payload.run).toMatchObject({ suite: "contract", trigger: "main", prNumber: null });
  });

  test("a missing shard directory is a skip, not a failure", async () => {
    const result = await runChild(
      ["bun", "scripts/e2e/tracker-ingest.ts", "--shards", "/nonexistent-shards"],
      {
        env: {
          PATH: process.env.PATH,
          GITHUB_REPOSITORY: "o/r",
          TRACKER_SHA: "a",
          TRACKER_REF: "main",
        },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no shard result to report");
  });
});
