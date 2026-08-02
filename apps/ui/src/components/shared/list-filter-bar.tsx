import { X } from "lucide-react";
import type { ReactNode } from "react";
import { SearchBox } from "@/components/shared/search-box";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ListFilterBarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  children?: ReactNode;
  hasActiveFilters?: boolean;
  onClear?: () => void;
  className?: string;
}

/**
 * Shared, wrapping toolbar for URL-backed list search and facets.
 *
 * The search control takes a full row on narrow screens while facets wrap
 * below it. Consumers own query-param names and filtering semantics.
 */
export function ListFilterBar({
  searchValue,
  onSearchChange,
  searchPlaceholder,
  children,
  hasActiveFilters = false,
  onClear,
  className,
}: ListFilterBarProps) {
  return (
    <div className={cn("flex shrink-0 flex-wrap items-center gap-3", className)}>
      <SearchBox
        value={searchValue}
        onChange={onSearchChange}
        placeholder={searchPlaceholder}
        className="w-full sm:max-w-sm sm:flex-1"
      />
      {children}
      {hasActiveFilters && onClear ? (
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground sm:ml-auto"
          onClick={onClear}
        >
          <X className="size-3" />
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
