import { resolve } from "node:path";
import { loadMetricRangeFixture } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { registerWorker } from "./core-helpers";

async function checkFirstDayOfRange(ctx: ScenarioContext, template: unknown) {
  const dayMs = 86_400_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    const today = Math.floor(Date.now() / dayMs);
    const first = new Date((today - 30) * dayMs).toISOString().slice(0, 10);
    const before = new Date((today - 31) * dayMs).toISOString().slice(0, 10);
    const boundaryAgent = crypto.randomUUID();
    const history = await ctx.startFixtureSut(
      await loadMetricRangeFixture(boundaryAgent, first, before),
    );
    try {
      const created = await history.api("POST", "/api/metrics/definitions", {
        agentId: boundaryAgent,
        body: { title: `Metrics boundary ${ctx.nonce}`, definition: template },
      });
      expectStatus(created, [201], "create the UI dashboard on historical data");
      const id = asString(asRecord(created.json).id, "historical dashboard id");
      const boundary = await history.api("POST", `/api/metrics/definitions/${id}/run`, {
        body: { variables: { rangeModifier: "-30 days", agentFilter: boundaryAgent } },
      });
      expectStatus(boundary, [200], "run the UI template over the first day of -30 days");
      // Preparing the historical database can span UTC midnight. Rebuild against the new day.
      if (Math.floor(Date.now() / dayMs) !== today) continue;
      const rows = asRecords(asRecord(asRecords(boundary.json, "widgets")[0]?.result), "rows");
      expect(
        rows.length === 2 &&
          ["completed", "failed"].every((status) =>
            rows.some((row) => row.status === status && Number(row.tasks) === 1),
          ),
        `expected one task per format on ${first} and none from ${before}, got ${JSON.stringify(rows)}`,
      );
      return;
    } finally {
      await history.stop();
    }
  }
  throw new Error("The UTC day changed during both dashboard runs");
}

// The seeded starter dashboard runs on the engine that seeded it: every widget query
// and every variable options query, for each time range and with the filters set.
// The dashboard UI's new-dashboard template runs on both engines too.
export const metricsStarterDashboard: Scenario = {
  name: "metrics-starter-dashboard",
  order: 9_446,
  async run(ctx) {
    const agentId = await registerWorker(ctx, "metrics-starter");
    const response = await ctx.api("GET", "/api/metrics/definitions?agentId=system&fields=full");
    expectStatus(response, [200], "list the system metrics");
    const starter = asRecords(response.json, "metrics").find(
      (metric) => metric.slug === "swarm-operations-overview",
    );
    expect(starter !== undefined, "The starter dashboard is not seeded");
    const metricId = asString(starter.id, "starter id");
    const definition = asRecord(starter.definition);
    const widgetCount = asRecords(definition, "widgets").length;
    const range = asRecords(definition, "variables").find((v) => v.key === "rangeModifier");
    const ranges = asRecords(range, "options").map((option) => option.value);
    expect(ranges.length > 0, "The time range variable has no options");

    const runs = [
      ...ranges.map((rangeModifier) => ({ rangeModifier })),
      { rangeModifier: ranges[0], agentFilter: agentId },
    ];
    for (const variables of runs) {
      const run = await ctx.api("POST", `/api/metrics/definitions/${metricId}/run`, {
        body: { variables },
      });
      expectStatus(run, [200], `run the starter dashboard with ${JSON.stringify(variables)}`);
      const widgets = asRecords(run.json, "widgets");
      expect(
        widgets.length === widgetCount,
        `ran ${widgets.length} of ${widgetCount} widgets with ${JSON.stringify(variables)}`,
      );
      for (const widget of widgets) {
        expect(
          Array.isArray(asRecord(widget.result).rows),
          `widget ${asRecord(widget.widget).id} returned no rows array`,
        );
      }
      // The options queries ran too: the requester and agent lists are filled.
      const resolved = asRecords(asRecord(asRecord(run.json).metric).definition, "variables");
      for (const key of ["userFilter", "agentFilter"]) {
        const options = asRecords(
          resolved.find((v) => v.key === key),
          "options",
        );
        expect(options[0]?.value === "all", `${key} options do not start with "all"`);
      }
      const agents = asRecords(
        resolved.find((v) => v.key === "agentFilter"),
        "options",
      );
      expect(
        agents.some((option) => option.value === agentId),
        "The agent options query does not list the new agent",
      );
    }

    const template = await Bun.file(
      resolve(import.meta.dir, "../../../apps/ui/src/pages/metrics/new-metric-definition.json"),
    ).json();
    // An operator added SQLite calendar ranges to the template's options.
    const saved = structuredClone(template);
    const savedRange = asRecords(saved, "variables").find((v) => v.key === "rangeModifier");
    const savedOptions = asRecord(savedRange).options;
    expect(Array.isArray(savedOptions), "The UI template has no time range options");
    savedOptions.push(
      { label: "Last month", value: "-1 month" },
      { label: "Last year", value: "-1 year" },
    );
    const created = await ctx.api("POST", "/api/metrics/definitions", {
      agentId,
      body: { title: `New dashboard template ${ctx.nonce}`, definition: saved },
    });
    expectStatus(created, [201], "create a dashboard from the UI template");
    const templateId = asString(asRecord(created.json).id, "template metric id");
    // The template keeps the time range, bound as a start instant ({{rangeModifier:since}}):
    // a task created now counts in every range.
    const task = await ctx.api("POST", "/api/tasks", {
      body: {
        task: `metrics template ${ctx.nonce}`,
        agentId,
        routingReason: "human_pinned",
        source: "api",
      },
    });
    expectStatus(task, [201], "create a task for the template");
    const templateRanges = asRecords(
      asRecords(template, "variables").find((v) => v.key === "rangeModifier"),
      "options",
    ).map((option) => option.value);
    expect(templateRanges.length === 3, "The UI template lost its time range");
    // A range an operator saved on SQLite, such as "-1 month", runs on both engines.
    for (const rangeModifier of [...templateRanges, "-1 month", "-1 year"]) {
      const run = await ctx.api("POST", `/api/metrics/definitions/${templateId}/run`, {
        body: { variables: { rangeModifier, agentFilter: agentId } },
      });
      expectStatus(run, [200], `run the UI template over ${String(rangeModifier)}`);
      const rows = asRecords(asRecord(asRecords(run.json, "widgets")[0]?.result), "rows");
      const total = rows.reduce((sum, row) => sum + Number(row.tasks), 0);
      expect(total === 1, `the UI template counted ${total} tasks over ${String(rangeModifier)}`);
    }

    await checkFirstDayOfRange(ctx, template);

    for (const variables of [{}, { agentFilter: agentId, userFilter: "nobody" }]) {
      const run = await ctx.api("POST", `/api/metrics/definitions/${templateId}/run`, {
        body: { variables },
      });
      expectStatus(run, [200], `run the UI template with ${JSON.stringify(variables)}`);
      expect(
        asRecords(run.json, "widgets").length === asRecords(template, "widgets").length,
        "The UI template did not run every widget",
      );
    }
  },
};
