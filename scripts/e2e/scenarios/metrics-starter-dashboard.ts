import { resolve } from "node:path";
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerWorker } from "./core-helpers";

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
    const metricId = asString(starter!.id, "starter id");
    const definition = asRecord(starter!.definition);
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
    const created = await ctx.api("POST", "/api/metrics/definitions", {
      agentId,
      body: { title: `New dashboard template ${ctx.nonce}`, definition: template },
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
    for (const rangeModifier of templateRanges) {
      const run = await ctx.api("POST", `/api/metrics/definitions/${templateId}/run`, {
        body: { variables: { rangeModifier, agentFilter: agentId } },
      });
      expectStatus(run, [200], `run the UI template over ${String(rangeModifier)}`);
      const rows = asRecords(asRecord(asRecords(run.json, "widgets")[0]?.result), "rows");
      const total = rows.reduce((sum, row) => sum + Number(row.tasks), 0);
      expect(total === 1, `the UI template counted ${total} tasks over ${String(rangeModifier)}`);
    }
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
