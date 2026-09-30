import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDbForTests } from "../db/client.ts";
import { listBenchmarkVersions } from "./benchmark-routes.ts";
import { resetActiveRunsForTests, startServer } from "./server.ts";

const ENV_KEYS = [
  "EVALS_API_KEY",
  "EVALS_DB_PATH",
  "EVALS_DB_SYNC_URL",
  "EVALS_DB_AUTH_TOKEN",
  "EVALS_BENCHMARK_DIR",
] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

let dir: string;

beforeEach(async () => {
  resetDbForTests();
  resetActiveRunsForTests();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.EVALS_DB_PATH = ":memory:";
  dir = await mkdtemp(join(tmpdir(), "evals-benchmark-routes-"));
  process.env.EVALS_BENCHMARK_DIR = dir;
});

afterEach(async () => {
  resetActiveRunsForTests();
  resetDbForTests();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(dir, { recursive: true, force: true });
});

async function publish(version: string, publishedAt: string): Promise<void> {
  await mkdir(join(dir, version), { recursive: true });
  await Bun.write(join(dir, version, "snapshot.json"), JSON.stringify({ schema: 1, publishedAt }));
}

describe("public benchmark routes", () => {
  test("lists published versions newest first and skips directories without a snapshot", async () => {
    await publish("1.0", "2026-10-01T00:00:00.000Z");
    await publish("1.10", "2026-12-01T00:00:00.000Z");
    await publish("1.2", "2026-11-01T00:00:00.000Z");
    await mkdir(join(dir, "2.0"), { recursive: true });
    await mkdir(join(dir, "drafts"), { recursive: true });
    expect(await listBenchmarkVersions(dir)).toEqual({
      versions: [
        { suiteVersion: "1.10", publishedAt: "2026-12-01T00:00:00.000Z" },
        { suiteVersion: "1.2", publishedAt: "2026-11-01T00:00:00.000Z" },
        { suiteVersion: "1.0", publishedAt: "2026-10-01T00:00:00.000Z" },
      ],
      latest: "1.10",
    });
  });

  test("an empty or missing directory lists nothing", async () => {
    expect(await listBenchmarkVersions(join(dir, "missing"))).toEqual({
      versions: [],
      latest: null,
    });
  });

  test("serve without auth while every other /api route still needs the key", async () => {
    process.env.EVALS_API_KEY = "example-test-master-key";
    await publish("1.0", "2026-10-01T00:00:00.000Z");
    const server = await startServer(0);
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const index = await fetch(`${base}/api/public/benchmark`);
      expect(index.status).toBe(200);
      expect(((await index.json()) as { latest: string }).latest).toBe("1.0");

      const snapshot = await fetch(`${base}/api/public/benchmark/1.0`);
      expect(snapshot.status).toBe(200);
      expect(await snapshot.json()).toEqual({ schema: 1, publishedAt: "2026-10-01T00:00:00.000Z" });

      expect((await fetch(`${base}/api/public/benchmark/9.9`)).status).toBe(404);
      expect((await fetch(`${base}/api/public/benchmark/..%2F..%2Fetc`)).status).toBe(400);
      expect((await fetch(`${base}/api/runs`)).status).toBe(401);
      expect((await fetch(`${base}/api/analytics/leaderboard`)).status).toBe(401);
    } finally {
      server.stop(true);
    }
  });
});
