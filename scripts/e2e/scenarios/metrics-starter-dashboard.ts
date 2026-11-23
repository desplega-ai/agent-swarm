import { resolve } from "node:path";
import { setTaskCreatedAt } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { createAssignedTask, registerWorker } from "./core-helpers";

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
    // An operator added SQLite calendar ranges to the template's options.
    const saved = structuredClone(template);
    const savedRange = asRecords(saved, "variables").find((v) => v.key === "rangeModifier");
    (asRecord(savedRange).options as unknown[]).push(
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

    // The first day of a range counts whole on both engines, whatever text format
    // SQLite keeps: one task per stored format on the first day of "-30 days", and
    // one per format on the day before it, which no range of 30 days counts.
    const dayMs = 86_400_000;
    const first = new Date(Date.now() - 30 * dayMs).toISOString().slice(0, 10);
    const before = new Date(Date.parse(`${first}T00:00:00.000Z`) - dayMs)
      .toISOString()
      .slice(0, 10);
    const boundaryAgent = await registerWorker(ctx, "metrics-boundary");
    for (const stored of [
      `${first} 00:00:01`,
      `${first}T00:00:02.000Z`,
      `${before} 23:59:59`,
      `${before}T23:59:59.000Z`,
    ]) {
      const id = await createAssignedTask(ctx, boundaryAgent, `metrics boundary ${stored}`);
      await setTaskCreatedAt(ctx.sutEnv, id, stored);
    }
    const boundary = await ctx.api("POST", `/api/metrics/definitions/${templateId}/run`, {
      body: { variables: { rangeModifier: "-30 days", agentFilter: boundaryAgent } },
    });
    expectStatus(boundary, [200], "run the UI template over the first day of -30 days");
    const boundaryRows = asRecords(
      asRecord(asRecords(boundary.json, "widgets")[0]?.result),
      "rows",
    );
    const boundaryTotal = boundaryRows.reduce((sum, row) => sum + Number(row.tasks), 0);
    expect(
      boundaryTotal === 2,
      `the UI template counted ${boundaryTotal} of the 2 tasks on ${first}, the first day of -30 days (one per SQLite text format), with the day before excluded`,
    );

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
