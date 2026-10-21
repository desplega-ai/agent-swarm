/**
 * Candidate fetch for memory search, sized in documents rather than rows.
 *
 * rerank() collapses the chunks of one task_completion document into its best
 * chunk. When those chunks fill the candidate window, the collapse leaves
 * fewer documents than the caller asked for while other matches sit just past
 * the cutoff. This fetch widens the window until it holds `limit` documents,
 * or the store has nothing more to return.
 */
import { collapsedDocumentKey } from "./reranker";
import type { MemoryCandidate, MemorySearchOptions, MemoryStore } from "./types";

/** Upper bound on one widened fetch. */
export const MAX_CANDIDATE_FETCH = 4096;
const WIDEN_FACTOR = 4;

export function countCandidateDocuments(candidates: MemoryCandidate[]): number {
  const documents = new Set<string>();
  let standalone = 0;
  for (const candidate of candidates) {
    const document = collapsedDocumentKey(candidate);
    if (document === null) standalone++;
    else documents.add(document);
  }
  return standalone + documents.size;
}

export async function searchMemoryCandidates(
  store: MemoryStore,
  embedding: Float32Array,
  agentId: string,
  options: MemorySearchOptions & { limit: number },
): Promise<MemoryCandidate[]> {
  let fetchLimit = options.limit;
  let rows = await store.search(embedding, agentId, { ...options, limit: fetchLimit });
  while (fetchLimit < MAX_CANDIDATE_FETCH) {
    const documents = countCandidateDocuments(rows);
    // Enough documents, or no chunk duplicates for the collapse to remove.
    if (documents >= options.limit || documents === rows.length) break;
    const nextLimit = Math.min(fetchLimit * WIDEN_FACTOR, MAX_CANDIDATE_FETCH);
    const wider = await store.search(embedding, agentId, { ...options, limit: nextLimit });
    if (wider.length <= rows.length) break; // the store is exhausted
    rows = wider;
    fetchLimit = nextLimit;
  }
  return rows;
}
