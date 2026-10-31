import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  cancelQuietly,
  claimTask,
  createAssignedTask,
  expectToolError,
  expectToolOk,
  registerWorker,
  UUID,
  withMcp,
} from "./core-helpers";

const GHOST = "00000000-0000-4000-8000-00000000dead";

/** The event stream: single and batch writes, filters, counts. */
async function events(ctx: ScenarioContext, agentId: string, taskId: string) {
  const sessionId = `core-events-${ctx.nonce}`;
  let response = await ctx.api("POST", "/api/events", {
    body: {
      category: "system",
      event: "system.boot",
      status: "ok",
      source: "api",
      agentId,
      taskId,
      sessionId,
      numericValue: 3.5,
      durationMs: 12,
      data: { field: `boot-${ctx.nonce}`, marker: ctx.nonce },
    },
  });
  expectStatus(response, [201], "store one event");
  const stored = asRecord(asRecord(response.json).event);
  expect(
    asRecord(response.json).success === true &&
      UUID.test(String(stored.id)) &&
      stored.numericValue === 3.5 &&
      stored.durationMs === 12 &&
      asRecord(stored.data).marker === ctx.nonce,
    `Unexpected stored event ${response.text}`,
  );
  expect(
    ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE id = ?", [String(stored.id)])
      ?.n === 1,
    "events table lacks the stored event",
  );

  response = await ctx.api("POST", "/api/events/batch", {
    body: {
      events: [
        { category: "tool", event: "tool.start", source: "worker", agentId, sessionId },
        { category: "tool", event: "tool.end", source: "worker", agentId, sessionId, status: "ok" },
        {
          category: "tool",
          event: "tool.end",
          source: "worker",
          agentId,
          sessionId,
          status: "error",
          data: { field: `tool-${ctx.nonce}` },
        },
      ],
    },
  });
  expectStatus(response, [201], "store an event batch");
  expect(asRecord(response.json).count === 3, "Batch count");
  expectStatus(
    await ctx.api("POST", "/api/events/batch", { body: { events: [{ category: "nope" }] } }),
    [400],
    "batch with an invalid event",
  );
  expectStatus(
    await ctx.api("POST", "/api/events", { body: { category: "tool", event: "tool.start" } }),
    [400],
    "event without a source",
  );

  // GET /api/events: every filter narrows the same stream.
  const query = async (qs: string) => {
    const result = await ctx.api("GET", `/api/events?agentId=${agentId}&${qs}`);
    expectStatus(result, [200], `events ${qs}`);
    return asRecords(result.json, "events");
  };
  expect((await query(`sessionId=${sessionId}`)).length === 4, "sessionId filter should match 4");
  expect((await query("category=tool")).length === 3, "category filter should match 3");
  expect((await query("event=tool.start")).length === 1, "event filter should match 1");
  expect((await query("status=error")).length === 1, "status filter should match 1");
  expect((await query("source=api")).length === 1, "source filter should match 1");
  expect((await query(`taskId=${taskId}`)).length === 1, "taskId filter should match 1");
  expect((await query("limit=2")).length === 2, "limit=2 should return 2");
  expect(
    (await query(`dataField=tool-${ctx.nonce}`)).length === 1,
    "dataField should match the data.field value",
  );
  expect(
    (await query("events=tool.start,system.boot")).length === 2,
    "events= should match either name",
  );
  expect((await query("since=2099-01-01T00:00:00.000Z")).length === 0, "since in the future");
  expect((await query("until=2000-01-01T00:00:00.000Z")).length === 0, "until in the past");
  const latest = await ctx.api(
    "GET",
    `/api/events?agentId=${agentId}&latestPerDataField=true&events=system.boot&dataFields=boot-${ctx.nonce}`,
  );
  expectStatus(latest, [200], "latest per data field");
  expect(asRecord(latest.json).latestPerDataField === true, "latestPerDataField flag missing");
  for (const qs of [
    "events=tool.start,bogus",
    "latestPerDataField=true",
    "status=weird",
    "limit=0",
  ]) {
    expectStatus(await ctx.api("GET", `/api/events?${qs}`), [400], `events ${qs}`);
  }

  response = await ctx.api("GET", `/api/events/counts?agentId=${agentId}&sessionId=${sessionId}`);
  expectStatus(response, [200], "event counts");
  const counts = new Map(asRecords(response.json, "counts").map((row) => [row.event, row.count]));
  expect(
    counts.get("tool.end") === 2 &&
      counts.get("tool.start") === 1 &&
      counts.get("system.boot") === 1,
    `Unexpected counts ${JSON.stringify([...counts])}`,
  );
  response = await ctx.api(
    "GET",
    `/api/events/counts?agentId=${agentId}&category=tool&source=worker`,
  );
  expect(
    asRecords(response.json, "counts").every((row) => String(row.event).startsWith("tool.")),
    "Count filters leaked other categories",
  );
}

/** Agent log, dashboard counters and the concurrent-context digest. */
async function dashboards(ctx: ScenarioContext, agentId: string, taskId: string) {
  let response = await ctx.api("GET", `/api/logs?agentId=${agentId}&limit=50`);
  expectStatus(response, [200], "agent logs");
  const logs = asRecords(response.json, "logs");
  expect(
    logs.some(
      (log) =>
        log.eventType === "task_status_change" &&
        log.taskId === taskId &&
        log.newValue === "in_progress",
    ),
    "The agent log lacks the task's start",
  );
  expect(
    logs.every((log) => log.agentId === agentId),
    "The agent filter leaked other agents",
  );
  response = await ctx.api("GET", "/api/logs?limit=2");
  expect(asRecords(response.json, "logs").length === 2, "limit=2 returned another count");
  expectStatus(await ctx.api("GET", "/api/logs?limit=0"), [400], "logs limit=0");

  response = await ctx.api("GET", "/api/stats");
  expectStatus(response, [200], "stats");
  const stats = asRecord(response.json);
  const agents = asRecord(stats.agents);
  const tasks = asRecord(stats.tasks);
  expect(
    Number(agents.total) >= 1 &&
      Number(agents.busy) >= 1 &&
      Number(tasks.in_progress) >= 1 &&
      Number(tasks.total) >= Number(tasks.in_progress),
    `Stats do not reflect the running task: ${response.text}`,
  );
  expect(
    stats.steeringEnabled === true &&
      stats.multiRuntimeEnabled === false &&
      stats.devMode === false,
    "Stats feature flags differ from the SUT configuration",
  );

  response = await ctx.api("GET", "/api/metrics");
  expectStatus(response, [200], "swarm metrics");
  const metrics = asRecord(response.json);
  expect(
    Number(asRecord(metrics.agents).total) === Number(agents.total) &&
      Number(asRecord(asRecord(metrics.tasks).by_status).in_progress) >= 1 &&
      typeof asRecord(metrics.workflows).enabled === "number" &&
      typeof metrics.retention === "object",
    `GET /api/metrics disagrees with /api/stats: ${response.text.slice(0, 300)}`,
  );

  response = await ctx.api("GET", "/api/concurrent-context");
  expectStatus(response, [200], "concurrent context");
  const context = asRecord(response.json);
  const active = asRecords(context, "activeSwarmTasks").find((task) => task.id === taskId);
  expect(
    active?.agentId === agentId &&
      active.status === "in_progress" &&
      typeof active.agentName === "string",
    "activeSwarmTasks omits the running task",
  );
  expect(
    Array.isArray(context.processingInboxMessages) && Array.isArray(context.recentTaskDelegations),
    "concurrent-context lacks its other lists",
  );
}

/** Heartbeat triggers and the channel-activity cursor commit. */
async function maintenance(ctx: ScenarioContext) {
  for (const route of ["sweep", "checklist"]) {
    const response = await ctx.api("POST", `/api/heartbeat/${route}`);
    expectStatus(response, [200], `heartbeat ${route}`);
    expect(
      asRecord(response.json).success === true &&
        String(asRecord(response.json).message).length > 0,
      `heartbeat ${route} answered ${response.text}`,
    );
    expectStatus(
      await ctx.api("POST", `/api/heartbeat/${route}`, { apiKey: null }),
      [401],
      `heartbeat ${route} without credentials`,
    );
  }

  const channelId = `CCORE${ctx.nonce}`;
  let response = await ctx.api("POST", "/api/channel-activity/commit-cursors", {
    body: { cursorUpdates: [{ channelId, ts: "1700000000.000100" }] },
  });
  expectStatus(response, [200], "commit a cursor");
  expect(asRecord(response.json).committed === 1, "committed count");
  response = await ctx.api("POST", "/api/channel-activity/commit-cursors", {
    body: { cursorUpdates: [{ channelId, ts: "1700000000.000200" }] },
  });
  expectStatus(response, [200], "advance the cursor");
  expect(
    ctx.db.get<{ lastSeenTs: string }>(
      "SELECT lastSeenTs FROM channel_activity_cursors WHERE channelId = ?",
      [channelId],
    )?.lastSeenTs === "1700000000.000200",
    "The cursor was not advanced in place",
  );
  response = await ctx.api("POST", "/api/channel-activity/commit-cursors", {
    body: { cursorUpdates: [] },
  });
  expect(asRecord(response.json).committed === 0, "An empty commit reported updates");
  expectStatus(
    await ctx.api("POST", "/api/channel-activity/commit-cursors", { body: {} }),
    [400],
    "commit without updates",
  );
}

const widget = (id: string, sql: string, params?: unknown[]) => ({
  id,
  title: `Widget ${id}`,
  query: { sql, ...(params ? { params } : {}) },
  viz: { type: id === "stat" ? "stat" : "table", ...(id === "stat" ? { value: "n" } : {}) },
});

/** Metric dashboards: definitions, versions, runs, plus the create_metric tool. */
async function metricDefinitions(ctx: ScenarioContext, agentId: string, otherId: string) {
  const slug = `core-metric-${ctx.nonce}`;
  const definition = {
    version: 1,
    widgets: [
      widget("stat", "SELECT COUNT(*) AS n FROM agents WHERE id = ?", ["{{agent}}"]),
      widget("rows", "SELECT id, status FROM agent_tasks WHERE agentId = ? LIMIT 5", ["{{agent}}"]),
    ],
    variables: [{ key: "agent", label: "Agent", type: "text", defaultValue: agentId }],
  };

  let response = await ctx.api("GET", "/api/metrics/schema");
  expectStatus(response, [200], "metric schema");
  expect(
    asRecord(asRecord(response.json).schema).type === "object",
    "The metric JSON schema is not an object schema",
  );

  response = await ctx.api("POST", "/api/metrics/definitions", {
    agentId,
    body: { slug, title: `Core metric ${ctx.nonce}`, description: "core e2e", definition },
  });
  expectStatus(response, [201], "create a metric");
  const metricId = String(asRecord(response.json).id);
  expect(asRecord(response.json).version === 1 && metricId.length > 0, "Create response");
  expectStatus(
    await ctx.api("POST", "/api/metrics/definitions", {
      agentId,
      body: { slug, title: "Duplicate", definition },
    }),
    [409],
    "duplicate slug for the same agent",
  );
  response = await ctx.api("POST", "/api/metrics/definitions", {
    agentId,
    body: {
      title: "Writes are refused",
      definition: { version: 1, widgets: [widget("rows", "DELETE FROM agents")] },
    },
  });
  expectStatus(response, [400], "a write query");
  expect(
    String(asRecord(response.json).error).includes("SELECT"),
    "400 lacks the SELECT-only reason",
  );
  expectStatus(
    await ctx.api("POST", "/api/metrics/definitions", {
      agentId,
      body: { title: "No widgets", definition: { version: 1, widgets: [] } },
    }),
    [400],
    "a definition without widgets",
  );

  // GET: single, list (filters, slim and full shapes), 404.
  response = await ctx.api("GET", `/api/metrics/definitions/${metricId}`);
  expectStatus(response, [200], "read the metric");
  const metric = asRecord(response.json);
  expect(
    metric.agentId === agentId &&
      metric.slug === slug &&
      asRecords(metric.definition, "widgets").length === 2,
    "Metric detail is wrong",
  );
  response = await ctx.api("GET", `/api/metrics/definitions?agentId=${agentId}`);
  expectStatus(response, [200], "list metrics for the agent");
  expect(
    asRecords(response.json, "metrics").length === 1 && asRecord(response.json).total === 1,
    "The agent filter should return only the created metric",
  );
  expect(
    !("definition" in asRecords(response.json, "metrics")[0]!),
    "Slim list carries the definition",
  );
  response = await ctx.api("GET", `/api/metrics/definitions?agentId=${agentId}&fields=full`);
  expect(
    "definition" in asRecords(response.json, "metrics")[0]!,
    "fields=full lacks the definition",
  );
  response = await ctx.api("GET", "/api/metrics/definitions?limit=1&offset=0");
  expect(
    asRecord(response.json).limit === 1 && asRecords(response.json, "metrics").length === 1,
    "limit",
  );
  expectStatus(await ctx.api("GET", `/api/metrics/definitions/${GHOST}`), [404], "unknown metric");

  // PUT: bumps the version and snapshots the previous one.
  response = await ctx.api("PUT", `/api/metrics/definitions/${metricId}`, {
    agentId,
    body: { title: `Renamed metric ${ctx.nonce}`, description: null },
  });
  expectStatus(response, [200], "update the metric");
  expect(asRecord(response.json).version === 2, `Update version ${response.text}`);
  expect(
    asRecord((await ctx.api("GET", `/api/metrics/definitions/${metricId}`)).json).title ===
      `Renamed metric ${ctx.nonce}`,
    "Update not applied",
  );
  response = await ctx.api("GET", `/api/metrics/definitions/${metricId}/versions`);
  expectStatus(response, [200], "metric versions");
  const versions = asRecords(response.json, "versions");
  expect(versions.length === 1 && versions[0]?.version === 1, "Expected one snapshot, v1");
  response = await ctx.api("GET", `/api/metrics/definitions/${metricId}/versions/1`);
  expectStatus(response, [200], "metric version 1");
  expect(
    asRecord(asRecord(response.json).snapshot).title === `Core metric ${ctx.nonce}`,
    "Version 1 does not hold the original title",
  );
  expectStatus(
    await ctx.api("GET", `/api/metrics/definitions/${metricId}/versions/9`),
    [404],
    "an unknown version",
  );
  expectStatus(
    await ctx.api("GET", `/api/metrics/definitions/${GHOST}/versions`),
    [404],
    "versions of an unknown metric",
  );
  expectStatus(
    await ctx.api("PUT", `/api/metrics/definitions/${GHOST}`, { body: { title: "x" } }),
    [404],
    "update an unknown metric",
  );

  // POST run: widgets execute their SQL with the resolved variables.
  response = await ctx.api("POST", `/api/metrics/definitions/${metricId}/run`, { body: {} });
  expectStatus(response, [200], "run with defaults");
  let run = asRecord(response.json);
  expect(asRecord(run.variables).agent === agentId, "The default variable was not applied");
  let widgets = asRecords(run, "widgets");
  expect(widgets.length === 2, "Run returned the wrong number of widgets");
  let rows = asRecords(asRecord(widgets[0]?.result), "rows");
  expect(rows[0]?.n === 1, `The stat widget should count the agent once: ${JSON.stringify(rows)}`);
  response = await ctx.api("POST", `/api/metrics/definitions/${metricId}/run`, {
    body: { variables: { agent: otherId } },
  });
  run = asRecord(response.json);
  widgets = asRecords(run, "widgets");
  rows = asRecords(asRecord(widgets[0]?.result), "rows");
  expect(
    asRecord(run.variables).agent === otherId && rows[0]?.n === 1,
    "The variable override was not used",
  );
  expectStatus(
    await ctx.api("POST", `/api/metrics/definitions/${GHOST}/run`, { body: {} }),
    [404],
    "run an unknown metric",
  );

  // create_metric: upsert by (agent, slug), SELECT-only.
  await withMcp(ctx, agentId, async (conn) => {
    const toolSlug = `core-tool-metric-${ctx.nonce}`;
    const created = await expectToolOk(conn, "create_metric", {
      title: `Tool metric ${ctx.nonce}`,
      slug: toolSlug,
      definition: { version: 1, widgets: [widget("stat", "SELECT COUNT(*) AS n FROM agents")] },
    });
    expect(
      created.message.includes(`slug=${toolSlug}`) && created.message.includes("version=1"),
      `create_metric message: ${created.message}`,
    );
    const toolMetricId = String(created.data.id);
    expect(String(created.data.app_url).endsWith("/usage/metrics"), "create_metric app_url");
    const updated = await expectToolOk(conn, "create_metric", {
      title: `Tool metric v2 ${ctx.nonce}`,
      slug: toolSlug,
      definition: {
        version: 1,
        widgets: [widget("stat", "SELECT COUNT(*) AS n FROM agent_tasks")],
      },
    });
    expect(
      updated.data.id === toolMetricId && updated.message.includes("version=2"),
      `A second call must update in place: ${updated.message}`,
    );
    const history = await ctx.api("GET", `/api/metrics/definitions/${toolMetricId}/versions`);
    expect(asRecords(history.json, "versions").length === 1, "The upsert did not snapshot v1");
    await expectToolError(
      conn,
      "create_metric",
      {
        title: "Rejected",
        definition: { version: 1, widgets: [widget("rows", "UPDATE agents SET name = 'x'")] },
      },
      "Metric query rejected",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/metrics/definitions/${toolMetricId}`),
      [204],
      "delete the tool-created metric",
    );
  });

  expectStatus(await ctx.api("DELETE", `/api/metrics/definitions/${metricId}`), [204], "delete");
  expectStatus(await ctx.api("GET", `/api/metrics/definitions/${metricId}`), [404], "read deleted");
  expectStatus(
    await ctx.api("DELETE", `/api/metrics/definitions/${metricId}`),
    [404],
    "delete again",
  );
}

export const coreTelemetry: Scenario = {
  name: "core-telemetry",
  order: 250,
  async run(ctx) {
    const agentId = await registerWorker(ctx, "telemetry");
    const otherId = await registerWorker(ctx, "telemetry-other");
    const taskId = await createAssignedTask(ctx, agentId, `telemetry task ${ctx.nonce}`);
    await claimTask(ctx, agentId, taskId);
    await events(ctx, agentId, taskId);
    await dashboards(ctx, agentId, taskId);
    await maintenance(ctx);
    await metricDefinitions(ctx, agentId, otherId);
    await cancelQuietly(ctx, taskId);
  },
};
