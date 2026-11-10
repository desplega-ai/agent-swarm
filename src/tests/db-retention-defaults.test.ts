/**
 * Retention defaults for new installs. The seed's own rules run in-process;
 * the "which boot seeds" rules run against a real `src/http.ts` process,
 * because only a real boot creates a database file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { Subprocess } from "bun";
import { closeDb, getSwarmConfigs, initDb, upsertSwarmConfig } from "../be/db";
import { wasDbCreatedThisBoot } from "../be/db/runtime";
import { DB_RETENTION_TABLES } from "../be/db-retention";
import { seedDbRetentionDefaults } from "../be/db-retention-defaults";
import { getFreePort, waitForServer } from "./test-net";

const KEYS = DB_RETENTION_TABLES.map((table) => table.envKey);
const DEFAULTS: Record<string, string> = {
  SESSION_LOG_RETENTION_DAYS: "30",
  AGENT_LOG_RETENTION_DAYS: "90",
  EVENTS_RETENTION_DAYS: "90",
  CONTEXT_VERSIONS_KEEP_LATEST: "100",
  SCRIPT_RUNS_RETENTION_DAYS: "30",
};
const ALL_UNSET = Object.fromEntries(KEYS.map((key) => [key, undefined]));

describe("seedDbRetentionDefaults", () => {
  let inheritedEnv: Record<string, string | undefined>;

  // The preload's afterEach puts the inherited values back.
  beforeEach(() => {
    inheritedEnv = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
    closeDb();
    initDb(":memory:");
  });

  afterEach(() => closeDb());

  async function storedRetention(): Promise<Record<string, string>> {
    const rows = await getSwarmConfigs({ scope: "global" });
    return Object.fromEntries(
      rows.filter((row) => KEYS.includes(row.key as never)).map((row) => [row.key, row.value]),
    );
  }

  test("the preload keeps retention off for servers the suite spawns", () => {
    expect(inheritedEnv).toEqual(Object.fromEntries(KEYS.map((key) => [key, "0"])));
  });

  test("a test database is not a new install, so the default call seeds nothing", async () => {
    expect(wasDbCreatedThisBoot()).toBe(false);
    expect(await seedDbRetentionDefaults()).toEqual([]);
    expect(await storedRetention()).toEqual({});
  });

  test("an existing install gets nothing", async () => {
    expect(await seedDbRetentionDefaults(false)).toEqual([]);
    expect(await storedRetention()).toEqual({});
  });

  test("a new install gets every default as a global row", async () => {
    await seedDbRetentionDefaults(true);
    expect(await storedRetention()).toEqual(DEFAULTS);
  });

  test("an env value or a stored row present at first boot wins over the default", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "7";
    process.env.EVENTS_RETENTION_DAYS = "0";
    await upsertSwarmConfig({ scope: "global", key: "SCRIPT_RUNS_RETENTION_DAYS", value: "365" });

    await seedDbRetentionDefaults(true);

    expect(await storedRetention()).toEqual({
      AGENT_LOG_RETENTION_DAYS: "90",
      CONTEXT_VERSIONS_KEEP_LATEST: "100",
      SCRIPT_RUNS_RETENTION_DAYS: "365",
    });
  });

  test("an empty or blank env value at first boot is the operator's off, not a gap to fill", async () => {
    process.env.SESSION_LOG_RETENTION_DAYS = "";
    process.env.AGENT_LOG_RETENTION_DAYS = "   ";

    await seedDbRetentionDefaults(true);

    expect(await storedRetention()).toEqual({
      EVENTS_RETENTION_DAYS: "90",
      CONTEXT_VERSIONS_KEEP_LATEST: "100",
      SCRIPT_RUNS_RETENTION_DAYS: "30",
    });
  });
});

describe("retention defaults across real boots", () => {
  const API_KEY = "example-test-retention-defaults-key";
  const BOOT_TEST_TIMEOUT_MS = 300_000;
  const headers = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

  type Api = { proc: Subprocess<"ignore", "pipe", "pipe">; base: string; stdout: Promise<string> };
  const booted: Api[] = [];
  const dbPaths: string[] = [];

  function newDbPath(): string {
    const dbPath = `/tmp/test-retention-defaults-${Date.now()}-${crypto.randomUUID()}.sqlite`;
    dbPaths.push(dbPath);
    return dbPath;
  }

  /** An `undefined` value removes the key from the inherited environment. */
  async function bootApi(dbPath: string, env: Record<string, string | undefined>): Promise<Api> {
    const port = await getFreePort();
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: dbPath,
      API_KEY,
      CAPABILITIES: "core",
      SLACK_DISABLE: "true",
      GITHUB_DISABLE: "true",
      ...env,
    };
    for (const [key, value] of Object.entries(childEnv))
      if (value === undefined) delete childEnv[key];
    const proc = Bun.spawn(["bun", "src/http.ts"], {
      cwd: `${import.meta.dir}/../..`,
      env: childEnv as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Drain both pipes from the start so a full buffer cannot stall the server.
    const stdout = new Response(proc.stdout).text();
    void new Response(proc.stderr).text();
    const api: Api = { proc, base: `http://127.0.0.1:${port}`, stdout };
    booted.push(api);
    // A cold first boot (migrations, seeds, transpile cache) can pass the 60 s default.
    await waitForServer(`${api.base}/health`, 120_000);
    return api;
  }

  /** Stop the server and return the line that reports what the sweep will apply. */
  async function stopAndReadSweepConfig(api: Api): Promise<string> {
    api.proc.kill("SIGTERM");
    await api.proc.exited;
    const line = (await api.stdout)
      .split("\n")
      .find((entry) => entry.includes("[db-retention] starting"));
    return line ?? "";
  }

  async function storedRetention(api: Api): Promise<Record<string, { id: string; value: string }>> {
    const res = await fetch(`${api.base}/api/config?scope=global`, { headers });
    expect(res.status).toBe(200);
    const { configs } = (await res.json()) as {
      configs: { id: string; key: string; value: string }[];
    };
    return Object.fromEntries(
      configs
        .filter((row) => KEYS.includes(row.key as never))
        .map((row) => [row.key, { id: row.id, value: row.value }]),
    );
  }

  const values = (rows: Record<string, { value: string }>) =>
    Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, row.value]));

  afterEach(async () => {
    for (const api of booted.splice(0)) {
      if (api.proc.exitCode === null) api.proc.kill("SIGKILL");
      await api.proc.exited.catch(() => {});
    }
    for (const dbPath of dbPaths.splice(0))
      for (const suffix of ["", "-wal", "-shm"]) await unlink(dbPath + suffix).catch(() => {});
  });

  test(
    "a new install stores the defaults, the env wins, and a deleted key stays deleted",
    async () => {
      const dbPath = newDbPath();
      const first = await bootApi(dbPath, { ...ALL_UNSET, SESSION_LOG_RETENTION_DAYS: "7" });
      const seeded = await storedRetention(first);
      const { SESSION_LOG_RETENTION_DAYS: _envOwned, ...seededDefaults } = DEFAULTS;
      expect(values(seeded)).toEqual(seededDefaults);

      const removed = await fetch(`${first.base}/api/config/${seeded.EVENTS_RETENTION_DAYS?.id}`, {
        method: "DELETE",
        headers,
      });
      expect(removed.status).toBe(200);
      const firstSweep = await stopAndReadSweepConfig(first);
      expect(firstSweep).toContain(
        "session_logs=7, agent_log=90, events=90, context_versions=100, script_runs=30",
      );
      expect(firstSweep).toContain("dryRun=false");

      const second = await bootApi(dbPath, ALL_UNSET);
      const { EVENTS_RETENTION_DAYS: _deleted, ...kept } = seededDefaults;
      expect(values(await storedRetention(second))).toEqual(kept);
      expect(await stopAndReadSweepConfig(second)).toContain(
        "session_logs=disabled, agent_log=90, events=disabled, context_versions=100, script_runs=30",
      );
    },
    BOOT_TEST_TIMEOUT_MS,
  );

  test(
    "a new install booted with empty or blank env values stores nothing and sweeps nothing",
    async () => {
      const blank = Object.fromEntries(KEYS.map((key, i) => [key, i % 2 === 0 ? "" : "  "]));
      const api = await bootApi(newDbPath(), blank);
      expect(await storedRetention(api)).toEqual({});
      expect(await stopAndReadSweepConfig(api)).toContain(
        "session_logs=disabled, agent_log=disabled, events=disabled, context_versions=disabled, script_runs=disabled",
      );
    },
    BOOT_TEST_TIMEOUT_MS,
  );

  test(
    "an existing database booted with every key unset stays unset",
    async () => {
      const dbPath = newDbPath();
      // The suite's inherited `0` values stand in for an install created before
      // the defaults existed: the database is built with no retention row.
      const before = await bootApi(dbPath, {});
      expect(await storedRetention(before)).toEqual({});
      await stopAndReadSweepConfig(before);

      const upgraded = await bootApi(dbPath, ALL_UNSET);
      expect(await storedRetention(upgraded)).toEqual({});
      expect(await stopAndReadSweepConfig(upgraded)).toContain(
        "session_logs=disabled, agent_log=disabled, events=disabled, context_versions=disabled, script_runs=disabled",
      );
    },
    BOOT_TEST_TIMEOUT_MS,
  );
});
