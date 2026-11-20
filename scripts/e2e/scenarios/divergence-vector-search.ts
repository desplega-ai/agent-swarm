import { sql, sqlList } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { callTool, expectToolOk, registerAgent } from "./knowledge-helpers";

// Locks in today's ordered results of memory vector search. The mock embeddings
// (scripts/e2e/mocks/llm.ts embeddingFor) are a deterministic bag of hashed words, so
// the cosine of a query to a memory grows with the words they share. Every memory
// has six words and shares 4, 3, 2, 1 or 0 of them with the first query, so the
// vector arm and the keyword arm agree on the order and the fused order is exact.
// The corpus text is fixed (no nonce): the nonce sits only in the keys, which are
// not embedded, so every run scores the same vectors.

const CORPUS: Record<string, string> = {
  v1: "copper lantern violet meadow anchor biscuit",
  v2: "copper lantern violet canyon dolphin ember",
  v3: "copper lantern falcon glacier hammock igloo",
  v4: "copper jasmine kiwi lagoon mango nectar",
  v5: "oyster pepper quartz raven saffron thistle",
};

async function search(ctx: ScenarioContext, agentId: string, query: string, prefix: string) {
  const response = await ctx.api("POST", "/api/memory/search", {
    agentId,
    body: { query, limit: 20, scope: "agent", keyPrefix: prefix },
  });
  expectStatus(response, [200], `memory search "${query}"`);
  return asRecords(response.json, "results").map((row) => {
    expect(
      typeof row.similarity === "number" && typeof row.rawSimilarity === "number",
      `memory search "${query}": result without similarity scores`,
    );
    return {
      id: asString(row.id, "memory id"),
      similarity: row.similarity as number,
      source: String(row.retrievalSource),
    };
  });
}

export const divergenceVectorSearch: Scenario = {
  name: "divergence-vector-search",
  order: 9_120,
  async run(ctx) {
    const owner = await registerAgent(ctx, "div-vec");
    const session = await ctx.connectMcp(owner);
    try {
      const prefix = `/longterm/facts/e2e-div-vec-${ctx.nonce}/`;
      const ids: Record<string, string> = {};
      for (const [label, content] of Object.entries(CORPUS)) {
        const stored = expectToolOk(
          await callTool(session, "memory-store", {
            content,
            name: `vector ${label}`,
            scope: "agent",
            key: `${prefix}${label}`,
          }),
          `memory-store ${label}`,
        );
        ids[label] = String((stored.data.memoryIds as unknown[])[0]);
      }
      const all = Object.values(ids);
      const embedded = await pollUntil(
        () =>
          ctx.db.get<{ n: number }>(
            sql`SELECT count(*) AS n FROM agent_memory WHERE id IN (${sqlList(all)}) AND "embeddingModel" IS NOT NULL`,
          )?.n === all.length,
        20_000,
        200,
      );
      expect(embedded, "the vector corpus never finished embedding");
      const label = (id: string) =>
        Object.entries(ids).find(([, value]) => value === id)?.[0] ?? `other:${id}`;

      // Each entry is "<memory>/<retrievalSource>": hybrid when both arms found it.
      const cases: { query: string; order: string[] }[] = [
        // Shares 4, 3, 2, 1 words with v1..v4 and none with v5.
        {
          query: "copper lantern violet meadow",
          order: ["v1/hybrid", "v2/hybrid", "v3/hybrid", "v4/hybrid"],
        },
        // v1 shares both words, v2 one; v3..v5 none.
        { query: "violet meadow", order: ["v1/hybrid", "v2/hybrid"] },
        // v5 shares both words. v2 shares none, but the hashed dimensions of "canyon"
        // overlap the query's (raw cosine about 0.11): a vector-only hit just above the
        // 0.1 floor. A new storage backend must keep the same floor on the same cosine.
        { query: "raven quartz", order: ["v5/hybrid", "v2/vec"] },
        // No shared word: every cosine is under the 0.1 floor and the keyword arm is empty.
        { query: "zebra", order: [] },
      ];
      for (const { query, order } of cases) {
        const rows = await search(ctx, owner, query, prefix);
        const got = rows.map((row) => `${label(row.id)}/${row.source}`);
        ctx.log(
          `"${query}": ${rows.map((r) => `${label(r.id)}=${r.similarity.toFixed(4)}/${r.source}`).join(" ")}`,
        );
        expect(
          JSON.stringify(got) === JSON.stringify(order),
          `memory search "${query}": expected [${order.join(", ")}], got [${got.join(", ")}]`,
        );
        for (let i = 1; i < rows.length; i++) {
          expect(
            rows[i - 1]!.similarity > rows[i]!.similarity,
            `memory search "${query}": scores are not strictly descending at ${got[i]}`,
          );
        }
      }

      // MCP memory-search returns the same order. It records an access on each hit,
      // which boosts later rankings, so it runs last.
      const mcp = expectToolOk(
        await callTool(session, "memory-search", {
          query: "copper lantern violet meadow",
          scope: "agent",
          limit: 20,
          keyPrefix: prefix,
        }),
        "memory-search",
      );
      const mcpOrder = (Array.isArray(mcp.data.results) ? mcp.data.results : []).map((row) =>
        label(asString(asRecord(row).id, "memory-search id")),
      );
      expect(
        JSON.stringify(mcpOrder) === JSON.stringify(["v1", "v2", "v3", "v4"]),
        `memory-search order: got [${mcpOrder.join(", ")}]`,
      );
    } finally {
      await session.close();
    }
  },
};
