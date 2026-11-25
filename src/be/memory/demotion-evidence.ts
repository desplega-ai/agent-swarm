import { getStorage } from "@/be/storage";
import { scrubSecrets } from "@/utils/secret-scrubber";
import type { DemotionEvidence, MemoryCandidate } from "./types";

type EvidenceRow = DemotionEvidence & { memoryId: string };

/**
 * Attach per-rater rating mass to candidates so rerank() can tell a memory
 * rated wrong from one rated off-topic. Only a net-negative pooled posterior
 * (beta > alpha) can be demoted, so only those candidates are looked up.
 *
 * The lookup runs on the engine's own memory search reader (the SQLite read
 * pool, or the Postgres client), like the other memory search reads. It is an
 * enrichment: if it fails, the candidates come back without evidence (so they
 * are not demoted) and the error is logged.
 */
export async function attachDemotionEvidence(
  candidates: MemoryCandidate[],
): Promise<MemoryCandidate[]> {
  const ids = [...new Set(candidates.filter((c) => c.beta > c.alpha).map((c) => c.id))];
  if (ids.length === 0) return candidates;
  const storage = getStorage();
  let rows: EvidenceRow[];
  try {
    rows = await storage.repos.memory.listDemotionEvidence(ids, storage.memoryIndexes.searchReader);
  } catch (err) {
    console.error(
      scrubSecrets(
        `[memory-search] demotion evidence lookup failed for ${ids.length} candidate(s); ranking without it: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
    return candidates;
  }
  if (rows.length === 0) return candidates;
  const byId = new Map(rows.map(({ memoryId, ...evidence }) => [memoryId, evidence]));
  return candidates.map((c) => {
    const demotionEvidence = byId.get(c.id);
    return demotionEvidence ? { ...c, demotionEvidence } : c;
  });
}
