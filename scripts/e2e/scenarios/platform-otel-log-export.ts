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

/**
 * `OTEL_EXPORT_API_LOGS=true` mirrors API console output to the OTLP collector. The bridge
 * must write to the LoggerProvider that the OTel SDK registered; a logs API from another
 * package version keeps its own global registry, and every bridged record goes nowhere
 * while traces still export. Boot the API against a local collector and require the API's
 * own boot line among the exported log records, with exported request spans as the
 * control that the collector is reachable.
 */
export const platformOtelLogExport: Scenario = {
  name: "platform-otel-log-export",
  order: 638,
  async run(ctx) {
    const collector = startCollector();
    let restarted = false;
    try {
      await ctx.restartSut({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.origin,
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_EXPORT_API_LOGS: "true",
          OTEL_BSP_SCHEDULE_DELAY: "200",
          OTEL_BLRP_SCHEDULE_DELAY: "200",
        },
      });
      restarted = true;
      expectStatus(await ctx.api("GET", "/api/agents"), [200], "request under OTel");

      const bodies = (path: string) =>
        collector.received.filter((r) => r.path === path).map((r) => r.body);
      // Control: the SDK exports request spans, so the collector is reachable.
      expect(
        await pollUntil(() => bodies("/v1/traces").length > 0, 15_000, 100),
        `no OTLP traces reached the collector; paths: ${collector.received.map((r) => r.path).join(",")}`,
      );
      // Target: the console line the API prints right after OTel boot is a log record.
      expect(
        await pollUntil(
          () => bodies("/v1/logs").some((body) => body.includes("[OTel] enabled for")),
          15_000,
          100,
        ),
        `bridged console output never reached the collector; paths: ${collector.received.map((r) => r.path).join(",")}`,
      );
    } finally {
      if (restarted) await ctx.restartSut();
      collector.server.stop(true);
    }
  },
};
