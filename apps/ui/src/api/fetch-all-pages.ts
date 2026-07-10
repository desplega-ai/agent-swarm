import type { PagesListResponse } from "./types";

export interface PagesBatchFilters {
  agentId?: string;
  limit?: number;
  offset?: number;
}

type PagesBatchFetcher = (filters: PagesBatchFilters) => Promise<PagesListResponse>;

// The pages endpoint caps individual requests at 500 rows. Keep each request
// bounded while walking the complete result set needed by client-side filters.
export const PAGES_BATCH_SIZE = 500;

export async function fetchAllPages(
  fetchBatch: PagesBatchFetcher,
  filters?: Pick<PagesBatchFilters, "agentId">,
): Promise<PagesListResponse> {
  const pages: PagesListResponse["pages"] = [];
  let total = 0;
  let offset = 0;

  do {
    const batch = await fetchBatch({
      ...filters,
      limit: PAGES_BATCH_SIZE,
      offset,
    });
    pages.push(...batch.pages);
    total = batch.total;
    offset += batch.pages.length;

    // Avoid retrying the same offset forever if rows disappear between the
    // count and a later batch. The next poll will reconcile the new snapshot.
    if (batch.pages.length === 0) break;
  } while (offset < total);

  return { pages, total };
}
