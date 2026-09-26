import { useEffect } from "react";
import type { SetURLSearchParams } from "react-router-dom";
import { resolveListPage } from "@/components/shared/list-pager";

/**
 * The page the Tasks list is on, given its `?page=` and the loaded `total`.
 * Once the total is known, a stale `?page=` moves to a real page and refetches
 * it (replace, so Back does not return to the dead URL). Until then `stale` is
 * true: the grid shows loading and the pager shows the target page, never
 * unfetched rows.
 */
export function useStalePageCorrection(
  page: number,
  pageSize: number,
  total: number | undefined,
  setSearchParams: SetURLSearchParams,
): { page: number; stale: boolean } {
  const { page: listPage, stale: pageStale } = resolveListPage(page, pageSize, total);
  useEffect(() => {
    if (!pageStale) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (listPage === 0) next.delete("page");
        else next.set("page", String(listPage));
        return next;
      },
      { replace: true },
    );
  }, [listPage, pageStale, setSearchParams]);
  return { page: listPage, stale: pageStale };
}
