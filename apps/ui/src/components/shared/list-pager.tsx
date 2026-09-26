import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface ListPagerProps {
  /** Zero-based page index. */
  page: number;
  pageSize: number;
  /** Total rows across every page. */
  total: number;
  pageSizeOptions: readonly number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** Shown instead of the range when there are no rows, e.g. "0 tasks". */
  emptyLabel?: string;
  className?: string;
}

/** "1–20 of 35" for the range summary; exported for tests. */
export function formatPagerRange(page: number, pageSize: number, total: number): string | null {
  const first = page * pageSize + 1;
  if (total <= 0 || first > total) return null;
  const last = Math.min((page + 1) * pageSize, total);
  return `${first}–${last} of ${total}`;
}

/**
 * The page a server-paged list should be on. A stale or hand-edited `?page=`
 * can point past the last page; once the server's `total` is known the caller
 * moves its URL here and refetches, so the URL, the fetched rows, the range and
 * Previous / Next all describe one page. The pager itself never clamps: it
 * would show rows that were never fetched. `total` is undefined while the first
 * response loads, which keeps the URL page so a deep link survives the load.
 */
export function resolveListPage(
  page: number,
  pageSize: number,
  total: number | undefined,
): { page: number; stale: boolean } {
  const requested = Number.isFinite(page) && page > 0 ? Math.floor(page) : 0;
  if (total === undefined) return { page: requested, stale: requested !== page };
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const resolved = Math.min(requested, lastPage);
  return { page: resolved, stale: resolved !== page };
}

/**
 * The one pager for every list in the dashboard: range on the left, rows per
 * page and previous / next on the right. Server-paged lists (Tasks, Memory)
 * drive it from URL state; `DataGrid` drives it from AG Grid's pagination API,
 * so both kinds of list read the same.
 */
export function ListPager({
  page,
  pageSize,
  total,
  pageSizeOptions,
  onPageChange,
  onPageSizeChange,
  emptyLabel = "0 rows",
  className,
}: ListPagerProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  // Wraps rather than overflows: with five-digit totals on a phone the range
  // and the controls do not fit one row, so the controls drop below it and
  // stay right-aligned (ml-auto) instead of pushing Next off-screen.
  return (
    <div
      className={cn(
        "flex shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1.5 text-sm text-muted-foreground",
        className,
      )}
    >
      <span className="whitespace-nowrap tabular-nums">
        {formatPagerRange(page, pageSize, total) ?? emptyLabel}
      </span>
      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <div className="flex items-center gap-1.5">
          <span className="hidden text-xs sm:inline">Rows</span>
          <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
            <SelectTrigger className="h-8 w-[72px]" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="hit-area h-8 w-8"
          disabled={page === 0}
          onClick={() => onPageChange(Math.max(0, page - 1))}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="whitespace-nowrap px-1 text-xs tabular-nums sm:px-2">
          Page {page + 1} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="hit-area h-8 w-8"
          disabled={page >= totalPages - 1}
          onClick={() => onPageChange(Math.min(totalPages - 1, page + 1))}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
