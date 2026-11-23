import { getStorage } from "@/be/storage";
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
  const rows: EvidenceRow[] = await getStorage().repos.memory.listDemotionEvidence(
    ids,
    memorySearchReader,
  );
  if (rows.length === 0) return candidates;
  const byId = new Map(rows.map(({ memoryId, ...evidence }) => [memoryId, evidence]));
  return candidates.map((c) => {
    const demotionEvidence = byId.get(c.id);
    return demotionEvidence ? { ...c, demotionEvidence } : c;
  });
}
