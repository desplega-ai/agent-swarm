import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, createTaskExtended, getDb, getTaskById, initDb } from "../be/db";
import { createEdgeHandler, getEdgeHandlerByName, patchEdgeHandler } from "../be/edge-handlers-db";
import { getEventsByEvent } from "../be/events";
import { aggregateHandlerStats, insertRoutingTrace, listTraceForRun } from "../be/routing-trace-db";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { runSeeder } from "../be/seed";
import { edgeHandlersSeeder } from "../be/seed-edge-handlers";
import { scriptsSeeder } from "../be/seed-scripts";
import { handleRouting } from "../http/routing";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { setApiKey } from "../utils/api-key";

const TEST_DB_PATH = "./test-routing-dryrun-stats.sqlite";
const TEST_PORT = 13068;
const BASE = `http://localhost:${TEST_PORT}`;

let server: Server;
let leadId: string;
let workerId: string;

const noOpEmbeddingProvider = {
  name: "test/noop-routing-dryrun-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
};

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function request(path: string, agentId: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Agent-ID": agentId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const savedApiKeyEnv = {
  AGENT_SWARM_API_KEY: process.env.AGENT_SWARM_API_KEY,
  API_KEY: process.env.API_KEY,
};

beforeAll(async () => {
  await removeDbFiles();
  initDb(TEST_DB_PATH);
  setApiKey("routing-dryrun-test-key");
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);
  leadId = createAgent({ name: "routing-dryrun-lead", isLead: true, status: "idle" }).id;
  workerId = createAgent({ name: "routing-dryrun-worker", isLead: false, status: "idle" }).id;
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    const handled = await handleRouting(
      req,
      res,
      getPathSegments(url),
      parseQueryParams(url),
      req.headers["x-agent-id"] as string | undefined,
    );
    if (!handled) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(TEST_PORT, resolve));
});

afterEach(() => {
  getDb().run("DELETE FROM edge_handlers");
  getDb().run("DELETE FROM scripts");
  getDb().run("DELETE FROM routing_trace");
  getDb().run("DELETE FROM agent_tasks");
  getDb().run("DELETE FROM seed_state WHERE kind = 'edge_handler'");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setScriptEmbeddingProviderForTests(null);
  // Restore, never setApiKey("") — an empty string is NOT nullish, so it would
  // shadow the real key for every later test file in the process.
  for (const [key, value] of Object.entries(savedApiKeyEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  closeDb();
  await removeDbFiles();
});

describe("routing dry-run and handler stats", () => {
  test("dry-run returns would-be decisions without applying task lifecycle mutations", async () => {
    await upsertScriptByName({
      name: "dry-run-hard",
      scope: "global",
      source: `export default async function run() { return { assignTo: ${JSON.stringify(workerId)} }; }`,
      description: "dry-run hard routing fixture",
      intent: "return a deterministic hard assignment for dry-run tests",
      signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
      agentId: leadId,
      typeChecked: true,
    });
    createEdgeHandler({
      name: "dry-run-hard",
      edge: "task.before_assign",
      scriptName: "dry-run-hard",
      flavor: "route",
      mode: "hard",
      matcher: { via: "creation" },
    });
    const beforeTasks = Number(
      (getDb().query("SELECT COUNT(*) AS count FROM agent_tasks").get() as { count: number }).count,
    );

    const response = await request("/api/routing/dry-run", leadId, {
      edge: "task.before_assign",
      envelope: { via: "creation", task: { description: "would be routed" } },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      final?: { assignTo?: string };
      trace: Array<{ handlerName: string; durationMs: number }>;
      routingRunId: string;
    };
    expect(body.trace[0]?.error).toBeUndefined();
    expect(body.final).toEqual({ assignTo: workerId });
    expect(body.trace).toHaveLength(1);
    expect(body.trace[0]).toMatchObject({ handlerName: "dry-run-hard" });
    expect(body.trace[0]?.durationMs).toEqual(expect.any(Number));
    expect(
      Number(
        (getDb().query("SELECT COUNT(*) AS count FROM agent_tasks").get() as { count: number })
          .count,
      ),
    ).toBe(beforeTasks);
    expect(listTraceForRun(body.routingRunId).every((trace) => trace.dryRun)).toBe(true);
    expect(getEventsByEvent("routing.applied")).toHaveLength(0);
    expect(getEventsByEvent("routing.blocked")).toHaveLength(0);

    const replay = createTaskExtended("replay this task", { source: "mcp" });
    const replayResponse = await request("/api/routing/dry-run", leadId, {
      edge: "task.before_assign",
      taskId: replay.id,
      envelope: { via: "creation" },
    });
    expect(replayResponse.status).toBe(200);
    expect((await replayResponse.json()) as { final?: { assignTo?: string } }).toMatchObject({
      final: { assignTo: workerId },
    });
    expect(getTaskById(replay.id)?.routingDirectives).toBeUndefined();

    const forbidden = await request("/api/routing/dry-run", workerId, {
      edge: "task.before_assign",
      envelope: { task: { description: "not permitted" } },
    });
    expect(forbidden.status).toBe(403);
  });

  test("aggregates handler stats, excluding dry-run traces, and enriches handler list", async () => {
    const statsHandler = createEdgeHandler({
      name: "stats-handler",
      edge: "task.before_assign",
      scriptName: "stats-script",
      flavor: "route",
      mode: "soft",
    });
    const base = {
      routingRunId: crypto.randomUUID(),
      edge: "task.before_assign" as const,
      via: "creation" as const,
      handlerId: statsHandler.id,
      handlerName: "stats-handler",
      flavor: "route" as const,
      mode: "soft" as const,
      matched: true,
    };
    insertRoutingTrace({ ...base, decisive: true, dryRun: false, durationMs: 20 });
    insertRoutingTrace({
      ...base,
      routingRunId: crypto.randomUUID(),
      decisive: false,
      dryRun: false,
      deviated: true,
      error: "failed",
      durationMs: 40,
    });
    insertRoutingTrace({
      ...base,
      routingRunId: crypto.randomUUID(),
      decisive: true,
      dryRun: true,
      durationMs: 99,
    });

    expect(aggregateHandlerStats()).toContainEqual({
      handlerId: statsHandler.id,
      handlerName: "stats-handler",
      hits: 2,
      decisive: 1,
      errors: 1,
      deviations: 1,
      avgDurationMs: 30,
      lastHitAt: expect.any(String),
    });

    const statsResponse = await request("/api/routing/stats?windowHours=24", workerId);
    expect(statsResponse.status).toBe(200);
    expect((await statsResponse.json()) as { stats: unknown[] }).toMatchObject({
      stats: [{ handlerName: "stats-handler", hits: 2, decisive: 1, errors: 1, deviations: 1 }],
    });
    const listResponse = await request("/api/routing/handlers", workerId);
    expect((await listResponse.json()) as { handlers: unknown[] }).toMatchObject({
      handlers: [
        { name: "stats-handler", stats: { hits: 2, decisive: 1, errors: 1, deviations: 1 } },
      ],
    });

    // Stats are keyed by handlerId, not name: a rename keeps the history (and
    // reports under the newest name), while an unrelated handler reusing the
    // retired name aggregates separately instead of inheriting it.
    const renamed = insertRoutingTrace({
      ...base,
      routingRunId: crypto.randomUUID(),
      handlerName: "stats-handler-renamed",
      decisive: false,
      dryRun: false,
      durationMs: 60,
    });
    getDb()
      .prepare("UPDATE routing_trace SET createdAt = datetime('now', '+1 hour') WHERE id = ?")
      .run(renamed.id);
    insertRoutingTrace({
      ...base,
      routingRunId: crypto.randomUUID(),
      handlerId: "imposter-handler-id",
      decisive: true,
      dryRun: false,
      durationMs: 10,
    });
    const aggregated = aggregateHandlerStats();
    expect(aggregated).toContainEqual({
      handlerId: statsHandler.id,
      handlerName: "stats-handler-renamed",
      hits: 3,
      decisive: 1,
      errors: 1,
      deviations: 1,
      avgDurationMs: 40,
      lastHitAt: expect.any(String),
    });
    expect(aggregated).toContainEqual({
      handlerId: "imposter-handler-id",
      handlerName: "stats-handler",
      hits: 1,
      decisive: 1,
      errors: 0,
      deviations: 0,
      avgDurationMs: 10,
      lastHitAt: expect.any(String),
    });
  });

  test("continuity seed is idempotent and preserves handler edits", async () => {
    // Scoped to the two seeders this feature owns (scripts first — the edge
    // handler references the seeded script). runAllSeeders drags in agent-fs
    // provisioning + skills and blows the test timeout on slow CI runners.
    const seedBoth = async () => {
      await runSeeder(scriptsSeeder, { quiet: true, scriptEmbeddingMode: "skip" });
      return runSeeder(edgeHandlersSeeder, { quiet: true });
    };
    const first = await seedBoth();
    const second = await seedBoth();
    expect(first.created).toBe(1);
    expect(second.skippedUnchanged).toBe(1);
    expect(
      getDb()
        .query("SELECT COUNT(*) AS count FROM scripts WHERE name = 'default-continuity-pin'")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      getDb()
        .query("SELECT COUNT(*) AS count FROM edge_handlers WHERE name = 'default-continuity-pin'")
        .get(),
    ).toEqual({ count: 1 });

    const seeded = getEdgeHandlerByName("default-continuity-pin")!;
    patchEdgeHandler(seeded.id, { enabled: false });
    const preserved = await runSeeder(edgeHandlersSeeder, { quiet: true });
    expect(preserved.skippedUserModified).toBe(1);
    expect(getEdgeHandlerByName("default-continuity-pin")?.enabled).toBe(false);
  }, 30_000);
});
