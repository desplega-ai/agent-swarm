import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
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

type OtlpAttribute = { key: string; value: { stringValue?: string } };
type OtlpSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
};
type OtlpLogRecord = { body?: { stringValue?: string }; traceId?: string; spanId?: string };

function spansOf(bodies: string[]): OtlpSpan[] {
  return bodies.flatMap(
    (body) =>
      (
        JSON.parse(body) as { resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[] }
      ).resourceSpans?.flatMap((r) => r.scopeSpans?.flatMap((s) => s.spans ?? []) ?? []) ?? [],
  );
}

function logsOf(bodies: string[]): OtlpLogRecord[] {
  return bodies.flatMap(
    (body) =>
      (
        JSON.parse(body) as {
          resourceLogs?: { scopeLogs?: { logRecords?: OtlpLogRecord[] }[] }[];
        }
      ).resourceLogs?.flatMap((r) => r.scopeLogs?.flatMap((s) => s.logRecords ?? []) ?? []) ?? [],
  );
}

const hasDbSystem = (s: OtlpSpan) => s.attributes?.some((a) => a.key === "db.system") ?? false;

/**
 * A timer armed inside a request runs outside that request's trace. A global
 * `PUT /api/config` arms the debounced integrations reload; before `runDetached`
 * the reload (and every loop it starts, like the Slack watcher) inherited the
 * request's OTel context, so one 8 ms request owned every DB span the background
 * loops emitted for the life of the process. The reload's own console line,
 * bridged to OTLP logs, is the target: it must carry no trace of the request.
 * Control: the request's own statement spans sit in that trace, so the
 * instrument attaches spans to request traces when it should.
 */
export const platformOtelDetachedTimers: Scenario = {
  name: "platform-otel-detached-timers",
  order: 638.6,
  async run(ctx) {
    const collector = startCollector();
    let restarted = false;
    let configId: string | undefined;
    try {
      await ctx.restartSut({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.origin,
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_EXPORT_API_LOGS: "true",
          OTEL_TRACE_DB_STATEMENTS: "true",
          OTEL_BSP_SCHEDULE_DELAY: "200",
          OTEL_BLRP_SCHEDULE_DELAY: "200",
        },
      });
      restarted = true;
      const bodies = (path: string) =>
        collector.received.filter((r) => r.path === path).map((r) => r.body);
      const paths = () => collector.received.map((r) => r.path).join(",");
      const reloadLogs = () =>
        logsOf(bodies("/v1/logs")).filter((l) =>
          l.body?.stringValue?.startsWith("[auto-reload] Loaded"),
        );
      const reloadsBefore = reloadLogs().length;

      const put = await ctx.api("PUT", "/api/config", {
        body: { scope: "global", key: `E2E_OTEL_DETACH_${ctx.nonce}`, value: "1" },
      });
      expectStatus(put, [200], "global config write under OTel");
      configId = asString(asRecord(put.json).id, "config id");

      const putSpan = () =>
        spansOf(bodies("/v1/traces")).find(
          (s) => s.name.startsWith("PUT /api/config") && !s.parentSpanId,
        );
      expect(
        await pollUntil(() => putSpan() !== undefined, 15_000, 100),
        `no PUT /api/config request span; paths: ${paths()}`,
      );
      const request = putSpan()!;

      // The debounced reload ran and its console line was exported.
      expect(
        await pollUntil(() => reloadLogs().length > reloadsBefore, 15_000, 100),
        `the integrations reload never logged; paths: ${paths()}`,
      );
      const reloadLog = reloadLogs().at(-1)!;
      expect(
        reloadLog.traceId !== request.traceId,
        `the reload armed by PUT /api/config ran inside its trace ${request.traceId}`,
      );

      // Control: the request's own statements are in its trace.
      const inTrace = () =>
        spansOf(bodies("/v1/traces")).filter(
          (s) => s.traceId === request.traceId && hasDbSystem(s),
        );
      expect(
        await pollUntil(() => inTrace().length > 0, 15_000, 100),
        "no statement spans under the PUT /api/config trace",
      );
      // Target: no statement in the request's trace starts after the request ended.
      const late = inTrace().filter(
        (s) => BigInt(s.startTimeUnixNano) > BigInt(request.endTimeUnixNano),
      );
      expect(
        late.length === 0,
        `${late.length} statement spans joined the PUT /api/config trace after it ended: ${late
          .slice(0, 5)
          .map((s) => s.name)
          .join(", ")}`,
      );
    } finally {
      if (configId) await ctx.api("DELETE", `/api/config/${configId}`).catch(() => undefined);
      if (restarted) await ctx.restartSut();
      collector.server.stop(true);
    }
  },
};
