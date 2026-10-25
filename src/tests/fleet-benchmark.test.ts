import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as db from "../be/db";
import { getTelemetryIngestAnchor, telemetryIngestRecorder } from "../be/telemetry-ingest-anchor";
import {
  compareWithFleet,
  type FleetBenchmarks,
  fleetBand,
  fleetBucketFor,
  fleetCountStart,
  localTasksPerWeek,
} from "../fleet-benchmark";
import {
  _resetTelemetryStateForTests,
  initTelemetry,
  setTelemetryIngestObserver,
  type TelemetryIngested,
  track,
} from "../telemetry";

type FleetBenchmarkRoute = typeof import("../http/fleet-benchmark");

/** A fresh module instance per test, so each starts with empty caches. */
let instances = 0;
async function freshRoute(): Promise<FleetBenchmarkRoute> {
  instances += 1;
  return (await import(`../http/fleet-benchmark?instance=${instances}`)) as FleetBenchmarkRoute;
}

const NOW = new Date("2026-10-12T00:00:00.000Z");
const DAY = 86_400_000;
const INSTALL_ID = "install_0123456789abcdef";
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

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
    expect(localTasksPerWeek({ ...fresh, countStart: ago(2) }, NOW)).toBe(70);
    expect(localTasksPerWeek({ ...fresh, tasksCreated: 300, countStart: ago(30) }, NOW)).toBe(70);
  });

  test("counts start where the proxy's do, or nowhere when that is unknown", () => {
    const start = (daysAgo: number) =>
      fleetCountStart({ occurredAt: ago(daysAgo) }, NOW)?.toISOString() ?? null;
    // Nothing accepted yet.
    expect(fleetCountStart(null, NOW)).toBeNull();
    expect(fleetCountStart({ occurredAt: "not a date" }, NOW)).toBeNull();
    // Accepted before the window: the proxy's first event is no later.
    expect(start(45)).toBe(ago(30));
    expect(start(30)).toBe(ago(30));
    // Inside the window: another emitter may have sent an earlier occurred_at.
    expect(start(29)).toBeNull();
    expect(start(10)).toBeNull();
  });

  test("uses the bucket where published and falls back to the whole fleet per metric", () => {
    const stats = {
      tasksCreated: 300,
      tasksCompleted: 95,
      tasksFailed: 5,
      countStart: ago(30),
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
      countStart: ago(30),
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
    await db.upsertSwarmConfig({
      scope: "global",
      key: "telemetry_installation_id",
      value: INSTALL_ID,
    });
    await accepted(40);
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

  /** Record an event the ingest endpoint accepted `daysAgo` days before NOW. */
  async function accepted(daysAgo: number): Promise<void> {
    await db.getDbClient().run("DELETE FROM swarm_config WHERE key = 'telemetry_first_ingest'");
    await telemetryIngestRecorder()({ installationId: INSTALL_ID, occurredAt: ago(daysAgo) });
  }

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

  test("telemetry off: local 30-day counts without an ingest anchor or proxy call", async () => {
    process.env.ANONYMIZED_TELEMETRY = "false";
    await db.getDbClient().run("DELETE FROM swarm_config WHERE key = 'telemetry_first_ingest'");
    await addTasks(9, "completed", 3);
    await addTasks(1, "failed", 3);
    await addTasks(5, "pending", 3);
    await addTasks(40, "completed", 45);
    await setProfile();
    const response = await buildFleetBenchmarkResponse(NOW);
    expect(response.state).toBe("telemetry_off");
    expect(response.local).toEqual({
      tasksPerWeek: 3.5,
      taskSuccessRate: 0.9,
      finishedTasks: 10,
      agents: 3,
      bucket: "2-5",
    });
    expect(response.level).toBe("full");
    expect(response.peerGroup).toBeNull();
    expect(response.comparisons).toEqual([]);
    expect(fetched).toEqual([]);
  });

  test("telemetry off on a fresh swarm returns zero counts", async () => {
    process.env.ANONYMIZED_TELEMETRY = "false";
    await db.getDbClient().run("DELETE FROM swarm_config WHERE key = 'telemetry_first_ingest'");
    expect(await buildFleetBenchmarkResponse(NOW)).toMatchObject({
      state: "telemetry_off",
      level: "basic",
      local: { tasksPerWeek: 0, taskSuccessRate: null, finishedTasks: 0 },
    });
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

  test("an empty stored name overrides the deployment name", async () => {
    const saved = process.env.SWARM_ORG_NAME;
    process.env.SWARM_ORG_NAME = "Deployment name";
    try {
      await db.upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_NAME", value: "" });
      expect((await buildFleetBenchmarkResponse(NOW)).state).toBe("no_org_name");
      expect(fetched).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.SWARM_ORG_NAME;
      else process.env.SWARM_ORG_NAME = saved;
    }
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
    await addTasks(40, "completed", 45); // Outside the window.
    const response = await buildFleetBenchmarkResponse(NOW);
    expect(response.state).toBe("ready");
    expect(response.level).toBe("basic");
    expect(response.peerGroup).toBeNull();
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

  async function setProfile(teamSize = "2-10", useCase = "features"): Promise<void> {
    await db.upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_WEBSITE", value: "acme.com" });
    await db.upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_TEAM_SIZE", value: teamSize });
    await db.upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_USE_CASE", value: useCase });
  }

  test("full profile requests peers and returns the proxy group", async () => {
    await addTasks(10, "completed", 1);
    await setProfile();
    proxyBody = {
      ...FLEET,
      peer_group: { team_size: "2-10", use_case: "features", orgs: 6 },
    };
    const response = await buildFleetBenchmarkResponse(NOW);
    expect(response).toMatchObject({
      state: "ready",
      level: "full",
      peerGroup: { teamSize: "2-10", useCase: "features", orgs: 6 },
    });
    expect(fetched).toEqual([
      "http://proxy.test/v1/fleet/benchmarks?window=30d&team_size=2-10&use_case=features",
    ]);
    await buildFleetBenchmarkResponse(NOW);
    expect(fetched).toHaveLength(1);
  });

  test("a use case the catalog does not list yet compares against the whole fleet", async () => {
    await addTasks(10, "completed", 1);
    await setProfile("2-10", "content");
    const response = await buildFleetBenchmarkResponse(NOW);
    expect(response).toMatchObject({ state: "ready", level: "full", peerGroup: null });
    expect(fetched).toEqual(["http://proxy.test/v1/fleet/benchmarks?window=30d"]);
  });

  test("full profile tolerates absent or null peer_group from the proxy", async () => {
    await addTasks(10, "completed", 1);
    await setProfile();
    for (const peer_group of [undefined, null]) {
      proxyBody = { ...FLEET, peer_group };
      const route = await freshRoute();
      const response = await route.buildFleetBenchmarkResponse(NOW);
      expect(response).toMatchObject({ state: "ready", level: "full", peerGroup: null });
    }
  });

  test("cache follows profile changes and cleared fields return to basic", async () => {
    await addTasks(10, "completed", 1);
    await buildFleetBenchmarkResponse(NOW);
    await setProfile();
    await buildFleetBenchmarkResponse(NOW);
    await setProfile("11-50", "bugs");
    await buildFleetBenchmarkResponse(NOW);
    await setProfile("11-50", "review");
    await buildFleetBenchmarkResponse(NOW);
    expect(fetched).toHaveLength(4);
    expect(fetched[2]).toContain("team_size=11-50&use_case=bugs");
    expect(fetched[3]).toContain("team_size=11-50&use_case=review");
    await db.upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_WEBSITE", value: "" });
    const response = await buildFleetBenchmarkResponse(NOW);
    expect(response.level).toBe("basic");
    expect(fetched.at(-1)).toBe("http://proxy.test/v1/fleet/benchmarks?window=30d");
  });

  test("partial profile stays basic and sends no peer filters", async () => {
    await addTasks(10, "completed", 1);
    for (const key of ["SWARM_ORG_WEBSITE", "SWARM_ORG_TEAM_SIZE", "SWARM_ORG_USE_CASE"]) {
      await setProfile();
      await db.upsertSwarmConfig({ scope: "global", key, value: "" });
      const route = await freshRoute();
      expect((await route.buildFleetBenchmarkResponse(NOW)).level).toBe("basic");
      expect(fetched.at(-1)).toBe("http://proxy.test/v1/fleet/benchmarks?window=30d");
    }
  });

  test("enabling telemetry never reuses local-only counts for comparison", async () => {
    await addTasks(10, "completed", 1);
    await db.getDbClient().run("DELETE FROM swarm_config WHERE key = 'telemetry_first_ingest'");
    process.env.ANONYMIZED_TELEMETRY = "false";
    expect((await buildFleetBenchmarkResponse(NOW)).local?.finishedTasks).toBe(10);
    process.env.ANONYMIZED_TELEMETRY = "true";
    expect(await buildFleetBenchmarkResponse(NOW)).toMatchObject({
      state: "unavailable",
      local: null,
    });
    expect(fetched).toEqual([]);
  });

  async function mintInstallId(daysAgo: number): Promise<void> {
    await db
      .getDbClient()
      .run("UPDATE swarm_config SET createdAt = ? WHERE key = 'telemetry_installation_id'", [
        ago(daysAgo),
      ]);
  }

  test("an install accepted 30+ days ago with its first task yesterday: the proxy's rate", async () => {
    await mintInstallId(30);
    await addTasks(70, "completed", 1);
    const response = await buildFleetBenchmarkResponse(NOW);
    // The proxy's reference: 70 tasks over 30 days.
    expect(response.local).toMatchObject({ tasksPerWeek: 16.3, finishedTasks: 70 });
  });

  test("mint time precedes the first accepted event: withheld, no proxy call", async () => {
    // Minted 30 days ago while the endpoint was unreachable; the first event
    // got through yesterday, and workers may have sent earlier ones.
    await mintInstallId(30);
    await accepted(1);
    await addTasks(70, "completed", 1);
    const response = await buildFleetBenchmarkResponse(NOW);
    expect(response).toMatchObject({ state: "unavailable", local: null, comparisons: [] });
    expect(fetched).toEqual([]);
  });

  test("no accepted event recorded, or one for another install ID: withheld", async () => {
    await addTasks(70, "completed", 1);
    await db.getDbClient().run("DELETE FROM swarm_config WHERE key = 'telemetry_first_ingest'");
    expect((await buildFleetBenchmarkResponse(NOW)).state).toBe("unavailable");

    const other = await freshRoute();
    await telemetryIngestRecorder()({
      installationId: "install_ffffffffffffffff",
      occurredAt: ago(40),
    });
    expect((await other.buildFleetBenchmarkResponse(NOW)).state).toBe("unavailable");
    expect(fetched).toEqual([]);
  });

  test("a worker's earlier clock inside the window: withheld, not the API's rate", async () => {
    // The API minted the ID 10 days ago and its first event, dated then, was
    // accepted. A worker with a slow clock then sent one dated 11 days ago,
    // which the proxy took as its first. Starting at the API's event would
    // report 49/week against the proxy's 44.5/week.
    await mintInstallId(10);
    await accepted(10);
    await addTasks(70, "completed", 5);
    const response = await buildFleetBenchmarkResponse(NOW);
    expect(response).toMatchObject({ state: "unavailable", local: null, comparisons: [] });
    expect(fetched).toEqual([]);
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

describe("telemetry ingest anchor", () => {
  const originalFetch = globalThis.fetch;
  const savedTelemetry = process.env.ANONYMIZED_TELEMETRY;
  let status: number;
  let sent: { event: string; occurred_at: string }[];
  let ingested: TelemetryIngested[];
  let store: Map<string, string>;
  const getConfig = async (key: string) => store.get(key);
  const setConfig = async (key: string, value: string) => {
    store.set(key, value);
  };

  async function flush(): Promise<void> {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeAll(() => {
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}");
      // Other suites' timers can send through this mock; keep only ours.
      if (body.event === "telemetry.enabled") sent.push(body);
      return new Response(null, { status });
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    if (savedTelemetry === undefined) delete process.env.ANONYMIZED_TELEMETRY;
    else process.env.ANONYMIZED_TELEMETRY = savedTelemetry;
    _resetTelemetryStateForTests();
  });

  beforeEach(() => {
    process.env.ANONYMIZED_TELEMETRY = "true";
    status = 202;
    sent = [];
    ingested = [];
    store = new Map();
    _resetTelemetryStateForTests();
  });

  async function boot(): Promise<void> {
    await initTelemetry("api-server", getConfig, setConfig, { generateIfMissing: true });
    setTelemetryIngestObserver((event) => {
      if (sent.some((body) => body.occurred_at === event.occurredAt)) ingested.push(event);
    });
  }

  test("an accepted event is reported with its install ID and occurred_at", async () => {
    const before = new Date().toISOString();
    await boot();
    track({ event: "telemetry.enabled", properties: { via: "env" } });
    await flush();
    expect(sent).toHaveLength(1);
    expect((sent[0]?.occurred_at ?? "") >= before).toBe(true);
    expect(ingested).toEqual([
      {
        installationId: store.get("telemetry_installation_id") ?? "",
        occurredAt: sent[0]?.occurred_at ?? "",
      },
    ]);
  });

  test("a refused send is not reported", async () => {
    status = 503;
    await boot();
    track({ event: "telemetry.enabled", properties: { via: "env" } });
    await flush();
    expect(sent).toHaveLength(1);
    expect(ingested).toEqual([]);
  });

  test("the record keeps the earliest accepted event", async () => {
    db.initDb(":memory:");
    try {
      await db.upsertSwarmConfig({
        scope: "global",
        key: "telemetry_installation_id",
        value: INSTALL_ID,
      });
      const recorder = telemetryIngestRecorder();
      const record = (daysAgo: number, installationId = INSTALL_ID) =>
        recorder({ installationId, occurredAt: ago(daysAgo) });

      await record(5);
      await record(3);
      expect(await getTelemetryIngestAnchor()).toEqual({
        installationId: INSTALL_ID,
        occurredAt: ago(5),
      });
      await record(8);
      expect(await getTelemetryIngestAnchor()).toMatchObject({ occurredAt: ago(8) });
      // Another recorder (a later telemetry init) reads the stored value.
      await telemetryIngestRecorder()({ installationId: INSTALL_ID, occurredAt: ago(6) });
      expect(await getTelemetryIngestAnchor()).toMatchObject({ occurredAt: ago(8) });

      // A new install ID starts over; the current install has no record then.
      await record(1, "install_ffffffffffffffff");
      expect(await getTelemetryIngestAnchor()).toBeNull();
    } finally {
      db.closeDb();
    }
  });
});
