import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { registerAgent } from "./knowledge-helpers";

/** More records than one reconcile chunk (200), so a pass spans two chunk transactions. */
const RECORDS = 250;
const KEPT = 50;
/**
 * The most `kv_entries` statements one sync request may run. The per-row write ran a read and
 * an upsert per row: about 500 for the refresh and 400 for the stale sweep below. The batched
 * write runs a few per chunk.
 */
const KV_STATEMENT_CAP = 30;

/** `dup` changes k0 and sends it twice in a row, so both copies land in one chunk. */
const SOURCE_SCRIPT = `export default async function main(args: { n?: number; dup?: boolean }) {
  const records = Array.from({ length: args.n ?? 0 }, (_, i) => ({ key: "k" + i, fields: { label: "row " + i } }));
  if (args.dup) {
    records[0] = { key: "k0", fields: { label: "changed" } };
    records.splice(1, 0, records[0]);
  }
  return records;
}
`;

/** A local OTLP/HTTP JSON collector that keeps the trace export bodies. */
function startCollector() {
  const traces: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.text();
      if (new URL(request.url).pathname === "/v1/traces") traces.push(body);
      return Response.json({});
    },
  });
  return { server, traces, origin: `http://127.0.0.1:${server.port}` };
}

type OtlpAttribute = { key: string; value: { stringValue?: string } };
type OtlpSpan = { traceId: string; spanId: string; name: string; attributes?: OtlpAttribute[] };

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

function definition(scriptId: string, n: number, dup = false): Record<string, unknown> {
  return {
    models: {
      item: {
        columns: {
          key: { kind: "string" },
          label: { kind: "string", source: { of: "feed", field: "label" } },
        },
        sources: { feed: { connector: "script", scriptId, joinKey: "key", args: { n, dup } } },
      },
    },
    queries: {},
    actions: {},
    pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
    defaultPage: "main",
  };
}

/**
 * A sync pass writes the rows it refreshes and the rows it marks stale in one multi-row
 * upsert per chunk, not one read and one upsert per row. The count comes from the
 * statement spans (`OTEL_TRACE_DB_STATEMENTS`) under the sync request's trace.
 */
export const knowledgeAppsSyncBatchedWrites: Scenario = {
  name: "knowledge-apps-sync-batched-writes",
  order: 558.9,
  async run(ctx) {
    const collector = startCollector();
    let restarted = false;
    try {
      await ctx.restartSut({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: collector.origin,
          OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
          OTEL_TRACE_DB_STATEMENTS: "true",
          OTEL_BSP_SCHEDULE_DELAY: "200",
        },
      });
      restarted = true;
      const owner = await registerAgent(ctx, "app-sync-batch-owner");
      const scriptName = `e2e-app-sync-batch-${ctx.nonce}`;
      const upserted = await ctx.api("POST", "/api/scripts/upsert", {
        agentId: owner,
        body: {
          name: scriptName,
          scope: "agent",
          description: "App sync source fixture",
          intent: "Return n keyed records",
          source: SOURCE_SCRIPT,
        },
      });
      expectStatus(upserted, [200], "upsert the source script");
      const listed = await ctx.api("GET", "/api/scripts?scope=agent&includeScratch=true");
      expectStatus(listed, [200], "list scripts");
      const script = asRecords(listed.json, "scripts").find(
        (s) => s.name === scriptName && s.scopeId === owner,
      );
      const scriptId = asString(script?.id, "source script id");

      const created = await ctx.api("POST", "/api/apps", {
        agentId: owner,
        body: {
          name: `E2E sync batch ${ctx.nonce}`,
          description: "batched sync writes",
          definition: definition(scriptId, RECORDS),
        },
      });
      expectStatus(created, [201], "create the app");
      const appId = asString(asRecord(asRecord(created.json).app).id, "app id");
      const syncPath = `/api/apps/${appId}/sync`;
      const rowsPath = `/api/apps/${appId}/models/item/rows?limit=${RECORDS}`;
      const seenRequests = new Set<string>();

      /** Run one sync; return its pass and the kv_entries statements of its request. */
      const sync = async (label: string) => {
        const response = await ctx.api("POST", syncPath, { body: {} });
        expectStatus(response, [200], label);
        const pass = asRecords(response.json, "passes")[0];
        expect(pass && asRecord(response.json).ok === true, `${label}: ${response.text}`);
        const request = () =>
          spansOf(collector.traces).find(
            (s) =>
              !seenRequests.has(s.spanId) &&
              attr(s, "http.request.method") === "POST" &&
              attr(s, "url.path") === syncPath,
          );
        expect(
          await pollUntil(() => request() !== undefined, 15_000, 100),
          `${label}: no request span for POST ${syncPath}`,
        );
        const span = request()!;
        seenRequests.add(span.spanId);
        // Statement spans end before their request span, so they were exported with it or earlier.
        const kvStatements = spansOf(collector.traces).filter(
          (s) => s.traceId === span.traceId && attr(s, "db.sql.table") === "kv_entries",
        ).length;
        return { pass, kvStatements };
      };
      const rows = async () => {
        const response = await ctx.api("GET", rowsPath);
        expectStatus(response, [200], "list rows");
        return new Map(asRecords(response.json, "rows").map((row) => [String(row.key), row]));
      };

      const first = await sync("first sync");
      expect(first.pass.created === RECORDS, `first sync creates: ${JSON.stringify(first.pass)}`);
      const before = await rows();

      // Every record again: one refresh per row, written in batches.
      const refresh = await sync("refresh sync");
      expect(
        refresh.pass.refreshed === RECORDS && refresh.pass.created === 0,
        `refresh sync counts: ${JSON.stringify(refresh.pass)}`,
      );
      expect(
        refresh.kvStatements > 0 && refresh.kvStatements <= KV_STATEMENT_CAP,
        `refresh sync ran ${refresh.kvStatements} kv_entries statements for ${RECORDS} rows (cap ${KV_STATEMENT_CAP})`,
      );
      const refreshed = await rows();
      const sample = refreshed.get("k7");
      expect(
        sample?.updatedAt === before.get("k7")?.updatedAt &&
          sample?.syncedAt !== before.get("k7")?.syncedAt &&
          sample?.stale === false,
        `a refresh keeps updatedAt and advances syncedAt: ${JSON.stringify(sample)}`,
      );

      // Shrink the source: the rest are swept stale, again in batches. k0 changes and comes
      // twice: the first copy updates it, the second starts from that write and only refreshes.
      const shrunk = await ctx.api("PUT", `/api/apps/${appId}`, {
        agentId: owner,
        body: { definition: definition(scriptId, KEPT, true) },
      });
      expectStatus(shrunk, [200], "shrink the source");
      const sweep = await sync("sweep sync");
      expect(
        sweep.pass.updated === 1 &&
          sweep.pass.refreshed === KEPT &&
          sweep.pass.markedStale === RECORDS - KEPT &&
          (sweep.pass.warnings as unknown[]).some((w) => String(w).includes('duplicate key "k0"')),
        `sweep sync counts: ${JSON.stringify(sweep.pass)}`,
      );
      expect(
        sweep.kvStatements > 0 && sweep.kvStatements <= KV_STATEMENT_CAP,
        `sweep sync ran ${sweep.kvStatements} kv_entries statements for ${RECORDS} rows (cap ${KV_STATEMENT_CAP})`,
      );
      const swept = await rows();
      const gone = swept.get(`k${RECORDS - 1}`);
      expect(
        swept.size === RECORDS &&
          gone?.stale === true &&
          gone.syncedAt === refreshed.get(`k${RECORDS - 1}`)?.syncedAt &&
          swept.get("k0")?.label === "changed" &&
          swept.get("k0")?.updatedAt !== refreshed.get("k0")?.updatedAt &&
          swept.get("k1")?.stale === false,
        `the sweep marks only the dropped rows stale, syncedAt frozen: ${JSON.stringify(gone)}`,
      );
      ctx.log(
        `kv_entries statements: refresh ${refresh.kvStatements}, sweep ${sweep.kvStatements} (${RECORDS} rows)`,
      );
    } finally {
      if (restarted) await ctx.restartSut();
      collector.server.stop(true);
    }
  },
};
