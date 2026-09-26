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
  if (total <= 0) return null;
  const first = page * pageSize + 1;
  const last = Math.min((page + 1) * pageSize, total);
  return `${first}–${last} of ${total}`;
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
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-2 text-sm text-muted-foreground",
        className,
      )}
    >
      <span className="whitespace-nowrap tabular-nums">
        {formatPagerRange(page, pageSize, total) ?? emptyLabel}
      </span>
      <div className="flex items-center gap-1.5 sm:gap-2">
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
          Page {Math.min(page + 1, totalPages)} of {totalPages}
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
