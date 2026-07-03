import { z } from "zod";

export const argsSchema = z.object({
  queries: z
    .array(z.string())
    .min(1)
    .describe("One or more search queries to fan out against the memory store"),
  scope: z
    .enum(["all", "agent", "swarm"])
    .optional()
    .describe("Memory scope filter (default all)"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max results per query (default 10)"),
});

/** Multi-query fan-out memory recall with dedup and composite reranking. */
export default async function smartRecall(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const { queries, scope = "all", limit = 10 } = parsed.data;

  const allResults: any[] = [];
  for (const q of queries) {
    const res: any = await ctx.swarm.memory_search({ query: q, limit, scope });
    const payload = res?.data ?? res;
    const results = payload?.results ?? [];
    for (const r of results) {
      allResults.push({ ...r, querySource: q });
    }
  }

  // Dedup by ID, keeping best similarity per memory
  const seen = new Map<string, any>();
  const hitCounts = new Map<string, number>();
  for (const r of allResults) {
    hitCounts.set(r.id, (hitCounts.get(r.id) ?? 0) + 1);
    const existing = seen.get(r.id);
    if (!existing || r.similarity > existing.similarity) {
      seen.set(r.id, r);
    }
  }

  // Composite rerank: bestSimilarity + 0.05 * hitCount
  const deduped = Array.from(seen.values()).map((r) => ({
    ...r,
    hits: hitCounts.get(r.id) ?? 1,
    compositeScore: r.similarity + 0.05 * (hitCounts.get(r.id) ?? 1),
  }));
  deduped.sort((a: any, b: any) => b.compositeScore - a.compositeScore);

  return {
    queriesRun: queries.length,
    totalCandidates: allResults.length,
    uniqueMemories: deduped.length,
    memories: deduped.slice(0, limit * 2),
  };
}
