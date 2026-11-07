/**
 * The state slot a named app query is mirrored into at `/queries/<name>`
 * (`/refs/<definingAppId>/queries/<name>` for a borrowed element's query).
 * Kept free of React so the mapping from a react-query result is unit-testable
 * against a real query client.
 */
import type { AppRow } from "@/api/types";

export const EMPTY_ROWS: AppRow[] = [];

export interface QuerySlot {
  data: AppRow[];
  /** First load only: no result yet. A background refetch never sets it. */
  loading: boolean;
  /**
   * Any fetch in flight, including a poll or `app.refresh` over rows that are
   * already showing. Bind `Table.refreshing` to it for the refetch bar.
   */
  fetching: boolean;
  error: string | null;
}

/** The slice of a react-query result a slot reads. */
export interface QueryResultLike {
  data?: { rows: AppRow[] };
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
}

export function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

/**
 * The slot for one query. `prev` is what the store already holds: rows survive
 * under the spinner while the query has no result yet. A parked query (route
 * params missing) never ran, so it says so instead of spinning forever.
 */
export function buildQuerySlot(
  missing: string[],
  result: QueryResultLike | undefined,
  prev: QuerySlot | undefined,
): QuerySlot {
  // The previous rows are RETAINED (not blanked) so content driven by the
  // param — a closing Drawer mid slide-out — doesn't flash empty; a fresh deep
  // link has no previous rows and still shows the empty state.
  if (missing.length) {
    return {
      data: prev?.data ?? EMPTY_ROWS,
      loading: false,
      fetching: false,
      error: `missing route param(s): ${missing.join(", ")}`,
    };
  }
  return {
    // `rows` is `[]` for a genuinely empty result, so `??` only falls through
    // when the query has NO result yet (fresh mount, evicted cache).
    data: result?.data?.rows ?? prev?.data ?? EMPTY_ROWS,
    loading: result?.isLoading ?? true,
    fetching: result?.isFetching ?? true,
    error: errorMessage(result?.error),
  };
}

export function sameQuerySlot(a: QuerySlot | undefined, b: QuerySlot): boolean {
  return (
    a !== undefined &&
    a.data === b.data &&
    a.loading === b.loading &&
    a.fetching === b.fetching &&
    a.error === b.error
  );
}
