import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUITE_SCENARIO_VERSIONS, SUITE_VERSION } from "../../scenarios/suite.ts";
import { MIN_ATTEMPTS_PER_CELL } from "../benchmark.ts";
import { publishBenchmark } from "../benchmark-publish.ts";
import { getDb, initDb, resetDbForTests } from "../db/client.ts";
import { createRun, insertAttempt, setRunStatus, updateAttempt } from "../db/queries.ts";
import { resetActiveRunsForTests, startServer } from "./server.ts";

const ENV_KEYS = [
  "EVALS_API_KEY",
  "EVALS_DB_PATH",
  "EVALS_DB_SYNC_URL",
  "EVALS_DB_AUTH_TOKEN",
  "EVALS_HARNESS_COMMIT",
] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

beforeEach(() => {
  resetDbForTests();
  resetActiveRunsForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
});
afterEach(() => {
  resetActiveRunsForTests();
  resetDbForTests();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const CONFIG = "claude-opus-5.5";
const COMMIT = "a".repeat(40);

/** A done run over every suite scenario, `perCell` graded attempts each. */
async function seed(id: string, perCell: number) {
  const db = getDb();
  const scenarioIds = Object.keys(SUITE_SCENARIO_VERSIONS);
  await createRun(db, {
    id,
    scenarioIds,
    configIds: [CONFIG],
    attemptsPerCell: perCell,
    concurrency: 2,
    preset: "weekly-matrix",
  });
  for (const scenarioId of scenarioIds) {
    for (let i = 0; i < perCell; i++) {
      const attemptId = `${id}_${scenarioId}_${i}`;
      await insertAttempt(db, {
        id: attemptId,
        runId: id,
        scenarioId,
        configId: CONFIG,
        attemptIndex: i,
        scenarioVersion: SUITE_SCENARIO_VERSIONS[scenarioId] ?? 1,
        suiteVersion: SUITE_VERSION,
      });
      await updateAttempt(db, attemptId, {
        status: i % 2 === 0 ? "passed" : "failed",
        score: i % 2 === 0 ? 0.9 : 0.2,
        passed: i % 2 === 0,
        costUsd: 0.1,
        resolvedModel: "claude-opus-5-5",
      });
    }
  }
  await setRunStatus(db, id, "done");
}

describe("GET /api/runs/:id/publish-bundle", () => {
  test("requires the API key, 404s an unknown run, 400s a malformed commit", async () => {
    process.env.EVALS_API_KEY = "k";
    const server = await startServer(0);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const auth = { headers: { Authorization: "Bearer k" } };
      expect((await fetch(`${base}/api/runs/nope/publish-bundle`)).status).toBe(401);
      expect((await fetch(`${base}/api/runs/nope/publish-bundle`, auth)).status).toBe(404);
      const bad = await fetch(`${base}/api/runs/nope/publish-bundle?harnessCommit=main`, auth);
      expect(bad.status).toBe(400);
    } finally {
      server.stop(true);
    }
  });

  test("returns the refusal lines for a run under the per-cell minimum", async () => {
    const server = await startServer(0);
    try {
      await seed("small", 2);
      const res = await fetch(`http://127.0.0.1:${server.port}/api/runs/small/publish-bundle`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; refusals: string[]; files?: unknown };
      expect(body.ok).toBe(false);
      expect(body.files).toBeUndefined();
      expect(body.refusals.join("\n")).toContain(
        `fewer than ${MIN_ATTEMPTS_PER_CELL} graded attempts`,
      );
    } finally {
      server.stop(true);
    }
  });

  test("returns the bundle publish would write, with the requested commit", async () => {
    const server = await startServer(0);
    try {
      await seed("full", MIN_ATTEMPTS_PER_CELL);
      const res = await fetch(
        `http://127.0.0.1:${server.port}/api/runs/full/publish-bundle?suite=${SUITE_VERSION}&harnessCommit=${COMMIT}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        refusals?: string[];
        configs: string[];
        snapshot: string;
        publishedAt: string;
        files: Record<string, string>;
      };
      expect(body.refusals).toBeUndefined();
      expect(body.ok).toBe(true);
      expect(body.configs).toEqual([CONFIG]);
      expect(body.snapshot).toBe(body.publishedAt.slice(0, 10));
      expect(Object.keys(body.files)).toContain("snapshot.json");
      expect(Object.keys(body.files)).toContain(`configs/${CONFIG}.json`);
      const snapshot = JSON.parse(body.files["snapshot.json"] ?? "{}") as {
        run: { id: string; harnessCommit: string | null };
      };
      expect(snapshot.run).toMatchObject({ id: "full", harnessCommit: COMMIT });
    } finally {
      server.stop(true);
    }
  });
});

describe("publishBenchmark writes a dated snapshot", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "evals-publish-snapshots-"));
    process.env.EVALS_BENCHMARK_DIR = root;
  });
  afterEach(async () => {
    delete process.env.EVALS_BENCHMARK_DIR;
    await rm(root, { recursive: true, force: true });
  });

  test("a later publish adds a directory and leaves the earlier week alone", async () => {
    await initDb();
    await seed("full", MIN_ATTEMPTS_PER_CELL);
    const db = getDb();
    const publishOn = (iso: string) =>
      publishBenchmark(db, {
        suiteVersion: SUITE_VERSION,
        runId: "full",
        harnessCommit: COMMIT,
        now: () => new Date(iso),
      });

    const first = await publishOn("2026-10-18T06:30:00.000Z");
    expect(first.ok).toBe(true);
    await Bun.write(join(root, SUITE_VERSION, "2026-10-18", "marker.txt"), "stale");
    const second = await publishOn("2026-10-25T07:30:00.000Z");
    expect(second.ok && second.outDir).toBe(join(root, SUITE_VERSION, "2026-10-25"));
    expect((await readdir(join(root, SUITE_VERSION))).sort()).toEqual(["2026-10-18", "2026-10-25"]);
    // The earlier snapshot is untouched, including a file the bundle does not write.
    expect(await Bun.file(join(root, SUITE_VERSION, "2026-10-18", "marker.txt")).text()).toBe(
      "stale",
    );

    // Same UTC day again: that day's directory is replaced whole, no stale file survives.
    await Bun.write(join(root, SUITE_VERSION, "2026-10-25", "marker.txt"), "stale");
    await publishOn("2026-10-25T23:00:00.000Z");
    expect(await Bun.file(join(root, SUITE_VERSION, "2026-10-25", "marker.txt")).exists()).toBe(
      false,
    );
    const written = JSON.parse(
      await Bun.file(join(root, SUITE_VERSION, "2026-10-25", "snapshot.json")).text(),
    ) as { publishedAt: string };
    expect(written.publishedAt).toBe("2026-10-25T23:00:00.000Z");
  });
});
