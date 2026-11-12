import { memorySearchReader } from "./search-reader";
import type { DemotionEvidence, MemoryCandidate } from "./types";

type EvidenceRow = DemotionEvidence & { memoryId: string };

/**
 * Attach per-rater rating mass to candidates so rerank() can tell a memory
 * rated wrong from one rated off-topic. Only a net-negative pooled posterior
 * (beta > alpha) can be demoted, so only those candidates are looked up.
 */
export async function attachDemotionEvidence(
  candidates: MemoryCandidate[],
): Promise<MemoryCandidate[]> {
  const ids = [...new Set(candidates.filter((c) => c.beta > c.alpha).map((c) => c.id))];
  if (ids.length === 0) return candidates;
  const rows = await memorySearchReader.query<EvidenceRow>(
    `SELECT memoryId,
            SUM(CASE WHEN source = 'explicit-self' AND signal > 0 THEN signal * weight ELSE 0 END) AS selfAlpha,
            SUM(CASE WHEN source = 'explicit-self' AND signal < 0 THEN -signal * weight ELSE 0 END) AS selfBeta,
            SUM(CASE WHEN source = 'llm' AND signal > 0 THEN signal * weight ELSE 0 END) AS llmAlpha,
            SUM(CASE WHEN source = 'llm' AND signal < 0 THEN -signal * weight ELSE 0 END) AS llmBeta,
            SUM(CASE WHEN source = 'llm' THEN 1 ELSE 0 END) AS llmCount
       FROM memory_rating
      WHERE source IN ('explicit-self', 'llm') AND memoryId IN (${ids.map(() => "?").join(", ")})
      GROUP BY memoryId`,
    ids,
  );
  if (rows.length === 0) return candidates;
  const byId = new Map(rows.map(({ memoryId, ...evidence }) => [memoryId, evidence]));
  return candidates.map((c) => {
    const demotionEvidence = byId.get(c.id);
    return demotionEvidence ? { ...c, demotionEvidence } : c;
  });
}
