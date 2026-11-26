import { expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";

/** A local OTLP/HTTP JSON collector: records each request path and body. */
function startCollector() {
  const received: { path: string; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received.push({ path: new URL(request.url).pathname, body: await request.text() });
      return Response.json({});
    },
  });
  return { server, received, origin: `http://127.0.0.1:${server.port}` };
}

type OtlpValue = { stringValue?: string; boolValue?: boolean; intValue?: string | number };
type OtlpAttribute = { key: string; value: OtlpValue };
type OtlpSpan = {
  name: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
};
type OtlpDataPoint = { attributes?: OtlpAttribute[]; asDouble?: number; asInt?: string | number };
type OtlpMetric = {
  name: string;
  histogram?: { dataPoints: OtlpDataPoint[] };
  sum?: { dataPoints: OtlpDataPoint[] };
  gauge?: { dataPoints: OtlpDataPoint[] };
};

const attr = (attributes: OtlpAttribute[] | undefined, key: string) => {
  const value = attributes?.find((a) => a.key === key)?.value;
  return value?.stringValue ?? value?.boolValue ?? value?.intValue;
};

function spansOf(bodies: string[]): OtlpSpan[] {
  return bodies.flatMap(
    (body) =>
      (
        JSON.parse(body) as { resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[] }
      ).resourceSpans?.flatMap((r) => r.scopeSpans?.flatMap((s) => s.spans ?? []) ?? []) ?? [],
  );
}

function metricsOf(bodies: string[]): OtlpMetric[] {
  return bodies.flatMap(
    (body) =>
      (
        JSON.parse(body) as { resourceMetrics?: { scopeMetrics?: { metrics?: OtlpMetric[] }[] }[] }
      ).resourceMetrics?.flatMap((r) => r.scopeMetrics?.flatMap((s) => s.metrics ?? []) ?? []) ??
      [],
  );
}

const points = (metrics: OtlpMetric[], name: string) =>
  metrics
    .filter((m) => m.name === name)
    .flatMap((m) => m.histogram?.dataPoints ?? m.sum?.dataPoints ?? m.gauge?.dataPoints ?? []);

/**
 * The storage StatementObserver exports database telemetry on both engines (issue #3582):
 * the statement duration histogram labelled with engine, operation and table, a child span
 * per statement under its request span when `OTEL_TRACE_DB_STATEMENTS` is on (statement
 * text only: the nonce bound as a parameter never reaches a span), and on PostgreSQL the
 * transaction outcome counter. On PostgreSQL the API also exports the server's `pg_stat_*`
 * gauges (`agentswarm.pg.*`); on SQLite it exports none.
 */
export const platformOtelDbStatements: Scenario = {
  name: "platform-otel-db-statements",
  order: 638.5,
  async run(ctx) {
    const collector = startCollector();
    const system = ctx.db.engine === "postgres" ? "postgresql" : "sqlite";
    let restarted = false;
    try {
      await ctx.restartSut({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.origin,
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_TRACE_DB_STATEMENTS: "true",
          OTEL_BSP_SCHEDULE_DELAY: "200",
          OTEL_METRIC_EXPORT_INTERVAL: "500",
        },
      });
      restarted = true;
      const marker = `otel-db-${ctx.nonce}`;
      expectStatus(
        await ctx.api("POST", "/api/tasks", { body: { task: marker, source: "ui" } }),
        [201],
        "task create under OTel",
      );
      expectStatus(await ctx.api("GET", "/api/agents"), [200], "agent list under OTel");

      const bodies = (path: string) =>
        collector.received.filter((r) => r.path === path).map((r) => r.body);
      const paths = () => collector.received.map((r) => r.path).join(",");

      // Metric: a SELECT on agents, labelled with this run's engine.
      const statementPoint = () =>
        points(metricsOf(bodies("/v1/metrics")), "agentswarm.db.statement.duration").find(
          (p) =>
            attr(p.attributes, "db.system") === system &&
            attr(p.attributes, "db.operation") === "SELECT" &&
            attr(p.attributes, "db.sql.table") === "agents",
        );
      expect(
        await pollUntil(() => statementPoint() !== undefined, 15_000, 100),
        `no agentswarm.db.statement.duration point for ${system} SELECT agents; paths: ${paths()}`,
      );
      if (system === "postgresql") {
        expect(
          await pollUntil(
            () =>
              points(metricsOf(bodies("/v1/metrics")), "agentswarm.db.transactions").some(
                (p) =>
                  attr(p.attributes, "db.system") === "postgresql" &&
                  attr(p.attributes, "outcome") === "commit",
              ),
            15_000,
            100,
          ),
          "no agentswarm.db.transactions commit point on postgresql",
        );
      }

      // Spans: an INSERT into agent_tasks nested in the POST /api/tasks server span.
      const insertSpan = () =>
        spansOf(bodies("/v1/traces")).find(
          (s) =>
            attr(s.attributes, "db.system") === system &&
            attr(s.attributes, "db.operation") === "INSERT" &&
            attr(s.attributes, "db.sql.table") === "agent_tasks",
        );
      expect(
        await pollUntil(() => insertSpan() !== undefined, 15_000, 100),
        `no INSERT agent_tasks statement span on ${system}; paths: ${paths()}`,
      );
      const child = insertSpan();
      // The request span ends after its statement span, so it can arrive in a later
      // export batch than the one that brought the child.
      const parentSpan = () =>
        spansOf(bodies("/v1/traces")).find((s) => s.spanId === child?.parentSpanId);
      await pollUntil(() => parentSpan() !== undefined, 15_000, 100);
      const parent = parentSpan();
      const spans = spansOf(bodies("/v1/traces"));
      expect(
        child && parent && parent.name.startsWith("POST /api/tasks"),
        `the statement span's parent is ${parent?.name ?? "missing"}, not the POST /api/tasks request span`,
      );
      const ns = (value: string) => BigInt(value);
      expect(
        ns(child.endTimeUnixNano) >= ns(child.startTimeUnixNano) &&
          ns(child.startTimeUnixNano) >= ns(parent.startTimeUnixNano) &&
          ns(child.endTimeUnixNano) <= ns(parent.endTimeUnixNano),
        "the statement span does not lie inside its request span",
      );
      const dbSpans = spans.filter((s) => attr(s.attributes, "db.system") !== undefined);
      expect(
        dbSpans.every((s) => !JSON.stringify(s).includes(marker)),
        "a statement span carries a bound parameter value",
      );
      expect(
        String(attr(child.attributes, "db.statement")).includes("agent_tasks"),
        "the statement span has no db.statement text",
      );

      // Postgres server gauges, read from pg_stat_* once per export.
      const pgMetrics = () =>
        metricsOf(bodies("/v1/metrics")).filter((m) => m.name.startsWith("agentswarm.pg."));
      if (system === "postgresql") {
        const required = [
          "agentswarm.pg.connections",
          "agentswarm.pg.connections.max",
          "agentswarm.pg.db.size",
          "agentswarm.pg.commits",
          "agentswarm.pg.cache.hit_ratio",
          "agentswarm.pg.query.max_age",
          "agentswarm.pg.table.dead_tuples",
          "agentswarm.pg.stat_statements.available",
        ];
        const missing = () => {
          const names = new Set(pgMetrics().map((m) => m.name));
          return required.filter((name) => !names.has(name));
        };
        expect(
          await pollUntil(() => missing().length === 0, 15_000, 100),
          `missing Postgres gauges: ${missing().join(", ")}`,
        );
        const metricsNow = metricsOf(bodies("/v1/metrics"));
        const value = (p: OtlpDataPoint | undefined) => Number(p?.asDouble ?? p?.asInt ?? 0);
        expect(
          value(points(metricsNow, "agentswarm.pg.db.size")[0]) > 0,
          "agentswarm.pg.db.size is not positive",
        );
        expect(
          points(metricsNow, "agentswarm.pg.connections").some(
            (p) => typeof attr(p.attributes, "state") === "string" && value(p) > 0,
          ),
          "no agentswarm.pg.connections point with a state",
        );
        expect(
          points(metricsNow, "agentswarm.pg.table.dead_tuples").every(
            (p) => typeof attr(p.attributes, "table") === "string",
          ),
          "an agentswarm.pg.table.dead_tuples point has no table attribute",
        );
      } else {
        // The statement metric above proved an export landed: none of it is Postgres.
        expect(
          pgMetrics().length === 0,
          `SQLite exported Postgres gauges: ${pgMetrics()
            .map((m) => m.name)
            .join(", ")}`,
        );
      }
    } finally {
      if (restarted) await ctx.restartSut();
      collector.server.stop(true);
    }
  },
};
