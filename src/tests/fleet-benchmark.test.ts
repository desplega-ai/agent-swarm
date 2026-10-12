import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../be/db";
import {
  compareWithFleet,
  type FleetBenchmarks,
  fleetBand,
  fleetBucketFor,
  localTasksPerWeek,
} from "../fleet-benchmark";

type FleetBenchmarkRoute = typeof import("../http/fleet-benchmark");

/** A fresh module instance per test, so each starts with empty caches. */
let instances = 0;
async function freshRoute(): Promise<FleetBenchmarkRoute> {
  instances += 1;
  return (await import(`../http/fleet-benchmark?instance=${instances}`)) as FleetBenchmarkRoute;
}

const NOW = new Date("2026-10-12T00:00:00.000Z");
const DAY = 86_400_000;

const metric = (p25: number, p50: number, p75: number, p90: number, n = 40) => ({
  n,
  p25,
  p50,
  p75,
  p90,
});

const FLEET: FleetBenchmarks = {
  window: "30d",
  generatedAt: "2026-10-11T23:00:00Z",
  minInstallsPerBucket: 20,
  minFinishedTasks: 10,
  overall: {
    installs: 94,
    tasksPerWeek: metric(19.3, 95.6, 333.9, 618.8, 94),
    taskSuccessRate: metric(0.579, 0.911, 0.983, 1, 94),
  },
  byAgentCount: {
    "2-5": {
      installs: 45,
      tasksPerWeek: metric(17.7, 101, 268.8, 466.2, 45),
      taskSuccessRate: { n: 12, omitted: "fewer than 20 installs" },
    },
  },
};

describe("fleet benchmark comparison", () => {
  test("bands follow the published percentiles", () => {
    const p = { p25: 10, p50: 20, p75: 30, p90: 40 };
    expect([45, 40, 35, 30, 25, 20, 15, 10, 5].map((v) => fleetBand(v, p))).toEqual([
      "top_10",
      "top_10",
      "top_25",
      "top_25",
      "above_median",
      "above_median",
      "below_median",
      "below_median",
      "bottom_25",
    ]);
  });

  test("buckets match the proxy's agent-count buckets", () => {
    expect([0, 1, 2, 5, 6, 30].map(fleetBucketFor)).toEqual([null, "1", "2-5", "2-5", "6+", "6+"]);
  });

  test("a new swarm's rate uses a 7-day floor, an old one the 30-day window", () => {
    const fresh = { tasksCreated: 70, tasksCompleted: 0, tasksFailed: 0, agents: 1 };
    expect(
      localTasksPerWeek(
        { ...fresh, firstSeenAt: new Date(NOW.getTime() - 2 * DAY).toISOString() },
        NOW,
      ),
    ).toBe(70);
    expect(
      localTasksPerWeek({ ...fresh, tasksCreated: 300, firstSeenAt: "2025-01-01T00:00:00Z" }, NOW),
    ).toBe(70);
  });

  test("an older install with a recent first task is measured from its first event", () => {
    const stats = {
      tasksCreated: 70,
      tasksCompleted: 0,
      tasksFailed: 0,
      firstSeenAt: new Date(NOW.getTime() - 30 * DAY).toISOString(),
      agents: 1,
    };
    // The proxy's reference: 70 tasks over 30 days.
    expect(localTasksPerWeek(stats, NOW)).toBe(16.3);
  });

  test("uses the bucket where published and falls back to the whole fleet per metric", () => {
    const stats = {
      tasksCreated: 300,
      tasksCompleted: 95,
      tasksFailed: 5,
      firstSeenAt: "2025-01-01T00:00:00Z",
      agents: 3,
    };
    expect(compareWithFleet(stats, FLEET, NOW)).toEqual([
      {
        key: "tasksPerWeek",
        value: 70,
        p50: 101,
        band: "below_median",
        peers: "2-5",
        installs: 45,
      },
      {
        key: "taskSuccessRate",
        value: 0.95,
        p50: 0.911,
        band: "above_median",
        peers: "all",
        installs: 94,
      },
    ]);
  });

  test("a bucket the proxy withheld compares against the whole fleet", () => {
    const stats = {
      tasksCreated: 3000,
      tasksCompleted: 10,
      tasksFailed: 0,
      firstSeenAt: null,
      agents: 1,
    };
    const [tasks, success] = compareWithFleet(stats, FLEET, NOW);
    expect(tasks).toMatchObject({ peers: "all", band: "top_10" });
    expect(success).toMatchObject({ peers: "all", band: "top_10", value: 1 });
  });
});

describe("GET /api/fleet-benchmark", () => {
  const originalFetch = globalThis.fetch;
  const savedTelemetry = process.env.ANONYMIZED_TELEMETRY;
  let fetched: string[];
  let proxyStatus: number;
  let proxyBody: unknown;
  let buildFleetBenchmarkResponse: FleetBenchmarkRoute["buildFleetBenchmarkResponse"];

  beforeAll(() => {
    globalThis.fetch = (async (url: string) => {
      fetched.push(String(url));
      return new Response(JSON.stringify(proxyBody), { status: proxyStatus });
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (savedTelemetry === undefined) delete process.env.ANONYMIZED_TELEMETRY;
    else process.env.ANONYMIZED_TELEMETRY = savedTelemetry;
  });

  beforeEach(async () => {
    db.initDb(":memory:");
    ({ buildFleetBenchmarkResponse } = await freshRoute());
    fetched = [];
    proxyStatus = 200;
    proxyBody = FLEET;
    process.env.ANONYMIZED_TELEMETRY = "true";
    await db.upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_NAME", value: "Acme" });
    await db.upsertSwarmConfig({
      scope: "global",
      key: "feedback_endpoint",
      value: "http://proxy.test/v1/feedback",
    });
    for (const id of ["a1", "a2", "a3"]) {
      await db.createAgent({
        id: `${id}000000-0000-4000-8000-000000000000`,
        name: id,
        isLead: false,
        status: "idle",
      });
    }
  });

  afterEach(() => db.closeDb());

  async function addTasks(count: number, status: string, daysAgo: number): Promise<void> {
    const at = new Date(NOW.getTime() - daysAgo * DAY).toISOString();
    for (let i = 0; i < count; i++) {
      await db.getDbClient().run(
        `INSERT INTO agent_tasks (id, task, status, source, createdAt, lastUpdatedAt, finishedAt, priority)
         VALUES (?, 'task', ?, 'api', ?, ?, ?, 50)`,
        [crypto.randomUUID(), status, at, at, status === "pending" ? null : at],
      );
    }
  }

  test("telemetry off: no proxy call and no local scan", async () => {
    process.env.ANONYMIZED_TELEMETRY = "false";
    const response = await buildFleetBenchmarkResponse(NOW);
    expect(response.state).toBe("telemetry_off");
    expect(response.local).toBeNull();
    expect(fetched).toEqual([]);
  });

  test("no org name: no proxy call", async () => {
    await db.upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_NAME", value: "  " });
    const saved = process.env.SWARM_ORG_NAME;
    delete process.env.SWARM_ORG_NAME;
    const response = await buildFleetBenchmarkResponse(NOW);
    if (saved !== undefined) process.env.SWARM_ORG_NAME = saved;
    expect(response.state).toBe("no_org_name");
    expect(fetched).toEqual([]);
  });

  test("fewer than 10 finished tasks: local numbers only", async () => {
    await addTasks(9, "completed", 3);
    await addTasks(5, "pending", 3);
    const response = await buildFleetBenchmarkResponse(NOW);
    expect(response.state).toBe("not_enough_tasks");
    expect(response.local).toMatchObject({ finishedTasks: 9, agents: 3, bucket: "2-5" });
    expect(fetched).toEqual([]);
  });

  test("ready: compares 30-day counts and caches the fleet for a day", async () => {
    await addTasks(57, "completed", 20);
    await addTasks(3, "failed", 20);
    await addTasks(40, "completed", 45); // Outside the window, but the first task.
    const response = await buildFleetBenchmarkResponse(NOW);
    expect(response.state).toBe("ready");
    expect(response.local).toEqual({
      tasksPerWeek: 14,
      taskSuccessRate: 0.95,
      finishedTasks: 60,
      agents: 3,
      bucket: "2-5",
    });
    expect(response.comparisons.map((c) => [c.key, c.peers, c.band])).toEqual([
      ["tasksPerWeek", "2-5", "bottom_25"],
      ["taskSuccessRate", "all", "above_median"],
    ]);
    expect(fetched).toEqual(["http://proxy.test/v1/fleet/benchmarks?window=30d"]);

    await buildFleetBenchmarkResponse(new Date(NOW.getTime() + 23 * 3_600_000));
    expect(fetched).toHaveLength(1);
  });

  async function mintInstallId(daysAgo: number): Promise<void> {
    await db.upsertSwarmConfig({
      scope: "global",
      key: "telemetry_installation_id",
      value: "install_0123456789abcdef",
    });
    await db
      .getDbClient()
      .run("UPDATE swarm_config SET createdAt = ? WHERE key = 'telemetry_installation_id'", [
        new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
      ]);
  }

  test("an install first seen 30 days ago with its first task yesterday: the proxy's rate", async () => {
    await mintInstallId(30);
    await addTasks(70, "completed", 1);
    const response = await buildFleetBenchmarkResponse(NOW);
    expect(response.local).toMatchObject({ tasksPerWeek: 16.3, finishedTasks: 70 });
  });

  test("tasks from before the install's first event are not counted", async () => {
    await addTasks(50, "completed", 20);
    await mintInstallId(10);
    await addTasks(20, "completed", 5);
    const response = await buildFleetBenchmarkResponse(NOW);
    expect(response.local).toMatchObject({ tasksPerWeek: 14, finishedTasks: 20 });
  });

  test.each([
    ["null agent-count buckets", { ...FLEET, byAgentCount: null }],
    [
      "a nonnumeric percentile",
      {
        ...FLEET,
        overall: { ...FLEET.overall, tasksPerWeek: { ...FLEET.overall.tasksPerWeek, p50: "95.6" } },
      },
    ],
  ])("malformed proxy body (%s): unavailable, not cached for a day", async (_label, body) => {
    await addTasks(10, "completed", 1);
    proxyBody = body;
    expect((await buildFleetBenchmarkResponse(NOW)).state).toBe("unavailable");
    expect((await buildFleetBenchmarkResponse(NOW)).state).toBe("unavailable");
    expect(fetched).toHaveLength(1);
    proxyBody = FLEET;
    const later = await buildFleetBenchmarkResponse(new Date(NOW.getTime() + 61 * 60_000));
    expect(later.state).toBe("ready");
    expect(fetched).toHaveLength(2);
  });

  test("proxy failure: unavailable, retried after an hour, not on every load", async () => {
    await addTasks(10, "completed", 1);
    proxyStatus = 503;
    expect((await buildFleetBenchmarkResponse(NOW)).state).toBe("unavailable");
    expect((await buildFleetBenchmarkResponse(NOW)).state).toBe("unavailable");
    expect(fetched).toHaveLength(1);
    proxyStatus = 200;
    const later = await buildFleetBenchmarkResponse(new Date(NOW.getTime() + 61 * 60_000));
    expect(later.state).toBe("ready");
    expect(fetched).toHaveLength(2);
  });
});
