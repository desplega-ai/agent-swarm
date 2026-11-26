import { expect, pollUntil } from "../http";
import type { Scenario } from "../run";
import { callToolOk, registerAgent, structured, withMcp } from "./script-helpers";
import { configureAgentFs, removeConfigs, startAgentFsStub } from "./sheets-helpers";

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
type OtlpSpan = { name: string; attributes?: OtlpAttribute[] };

const attr = (span: OtlpSpan, key: string) =>
  span.attributes?.find((a) => a.key === key)?.value.stringValue;

function spansOf(bodies: string[]): OtlpSpan[] {
  return bodies.flatMap(
    (body) =>
      (
        JSON.parse(body) as { resourceSpans?: { scopeSpans?: { spans?: OtlpSpan[] }[] }[] }
      ).resourceSpans?.flatMap((r) => r.scopeSpans?.flatMap((s) => s.spans ?? []) ?? []) ?? [],
  );
}

/**
 * Flow `data`: with OTLP on, a `data-query` call exports its `mcp.tool data-query` span with
 * the SQL replaced by `[omitted]` in args_preview and no result_preview rows, so a customer
 * literal in the SQL or in the returned rows never reaches the collector. Control: the same
 * span still exports the table binding path, so args are serialized and the scan can see them.
 */
export const dataQueryOtel: Scenario = {
  name: "data-query-otel",
  order: 638.7,
  async run(ctx) {
    const collector = startCollector();
    let restarted = false;
    const fake = startAgentFsStub(ctx, "data-otel");
    let configIds: string[] = [];
    try {
      await ctx.restartSut({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.origin,
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_BSP_SCHEDULE_DELAY: "200",
        },
      });
      restarted = true;
      const agentId = await registerAgent(ctx, "data-query-otel");
      configIds = await configureAgentFs(ctx, agentId, fake);
      const csv = `e2e/data/otel-control-${ctx.nonce}.csv`;
      const sentinel = `Private Customer Sentinel ${ctx.nonce}`;
      fake.files.set(csv, { body: "c\n1\n", version: 1 });
      fake.onOp((op) => {
        if (op.op === "stat") return Response.json({ path: `/${csv}`, currentVersion: 1 });
        if (op.op !== "sql") return undefined;
        return Response.json({
          columns: [{ name: "c", type: "VARCHAR" }],
          rows: [{ c: sentinel }],
          rowCount: 1,
          truncated: false,
          files: [{ table: "t", path: `/${csv}`, format: "csv" }],
          elapsedMs: 1,
        });
      });

      await withMcp(ctx, agentId, async (mcp) => {
        const rows = structured(
          await callToolOk(mcp, "data-query", {
            sql: `SELECT '${sentinel}' AS c FROM t`,
            tables: { t: `/${csv}` },
            origin: "e2e",
          }),
        );
        expect(
          JSON.stringify(rows.rows).includes(sentinel),
          `the stub rows came back: ${JSON.stringify(rows).slice(0, 300)}`,
        );
      });

      const traces = () =>
        collector.received.filter((r) => r.path === "/v1/traces").map((r) => r.body);
      const toolSpan = () =>
        spansOf(traces()).find(
          (s) => s.name === "mcp.tool data-query" && attr(s, "mcp.tool.name") === "data-query",
        );
      expect(
        await pollUntil(() => toolSpan() !== undefined, 15_000, 100),
        `no mcp.tool data-query span; paths: ${collector.received.map((r) => r.path).join(",")}`,
      );
      const span = toolSpan() as OtlpSpan;
      const args = attr(span, "agentswarm.tool.args_preview") ?? "";
      expect(
        args.includes(csv) && args.includes("[omitted]"),
        `control: args_preview still carries the binding path, SQL omitted: ${args}`,
      );
      expect(
        attr(span, "agentswarm.tool.result_preview") === "[omitted]",
        `result_preview drops the rows: ${attr(span, "agentswarm.tool.result_preview")}`,
      );
      const leaked = collector.received.filter((r) => r.body.includes(sentinel));
      expect(
        leaked.length === 0,
        `the SQL literal reached the collector on ${leaked.map((r) => r.path).join(",")}`,
      );
    } finally {
      fake.stop();
      await removeConfigs(ctx, configIds);
      if (restarted) await ctx.restartSut();
      collector.server.stop(true);
    }
  },
};
