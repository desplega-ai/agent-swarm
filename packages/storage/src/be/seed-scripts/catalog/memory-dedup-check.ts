import { z } from "zod";

export const argsSchema = z.object({
  text: z.string().describe("Candidate memory text to check for near-duplicates"),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Minimum cosine similarity to count as a duplicate (default 0.85)"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max existing memories to compare against (default 10)"),
});

/** Semantic-search existing memories and flag near-duplicates before you save a new one. */
export default async function memoryDedupCheck(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const text = parsed.data.text.trim();
  if (!text) return { error: "text must not be empty" };
  const threshold = parsed.data.threshold == null ? 0.85 : parsed.data.threshold;
  const limit = parsed.data.limit || 10;

  const res: any = await ctx.swarm.memory_search({ query: text, scope: "all", limit });
  if (res && res.success === false) {
    return { error: "memory_search failed with status " + res.status };
  }
  const payload: any = res && res.data ? res.data : res;
  const results: any = payload && Array.isArray(payload.results) ? payload.results : [];

  const duplicates: any[] = [];
  for (const r of results) {
    const score = typeof r.similarity === "number" ? r.similarity : 0;
    if (score >= threshold) {
      duplicates.push({
        id: r.id,
        name: r.name,
        similarity: Math.round(score * 1000) / 1000,
        scope: r.scope,
        source: r.source,
        preview: typeof r.content === "string" ? r.content.slice(0, 200) : "",
      });
    }
  }
  duplicates.sort((a: any, b: any) => b.similarity - a.similarity);

  return {
    isDuplicate: duplicates.length > 0,
    duplicateCount: duplicates.length,
    threshold,
    comparedAgainst: results.length,
    topSimilarity: results.length > 0 && typeof results[0].similarity === "number"
      ? Math.round(results[0].similarity * 1000) / 1000
      : 0,
    duplicates,
  };
}
