import { ListFilter, Search } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useRef } from "react";
import { SearchBox } from "@/components/shared/search-box";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { COMMENT_FILTERS, type CommentFilter } from "@/lib/comb/thread-filter";
import { cn } from "@/lib/utils";
import { PendingDot } from "./swarm-state";

/** An icon button of the rail header. `on`: it holds a value (a search, a filter). */
function RailIconButton({
  label,
  on,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string; on: boolean }) {
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      className={cn("relative shrink-0 text-muted-foreground", on && "text-foreground")}
      {...props}
    >
      {children}
      {on ? (
        <span aria-hidden className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary" />
      ) : null}
    </Button>
  );
}

/** Opens and closes the search row. Closing clears the search. */
export function SearchToggle({
  open,
  active,
  onToggle,
}: {
  open: boolean;
  /** The search holds text. */
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <RailIconButton
          label="Search comments"
          on={active}
          aria-expanded={open}
          data-comb-search-toggle=""
          onClick={onToggle}
        >
          <Search />
        </RailIconButton>
      </TooltipTrigger>
      <TooltipContent>Search comments</TooltipContent>
    </Tooltip>
  );
}

/**
 * The search field: comment and reply text, quoted passages, and author
 * names. Escape clears it and closes it, and the focus goes back to the
 * search button.
 */
export function CommentSearch({
  value,
  onChange,
  onClose,
}: {
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("input")?.focus();
  }, []);
  return (
    <div
      ref={ref}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <SearchBox
        value={value}
        onChange={onChange}
        placeholder="Search comments"
        clearable
        className="[&_input]:h-8"
      />
    </div>
  );
}

/** "Filter" menu: All, Pending, Processing, Mentions me, Mine, with counts. */
export function FilterMenu({
  value,
  counts,
  onChange,
}: {
  value: CommentFilter;
  /** Threads per filter in the current tab, with the search applied. */
  counts: Record<CommentFilter, number>;
  onChange: (filter: CommentFilter) => void;
}) {
  const current = COMMENT_FILTERS.find((item) => item.value === value)?.label ?? "All";
  const label = value === "all" ? "Filter comments" : `Filter comments: ${current}`;
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <RailIconButton label={label} on={value !== "all"}>
              <ListFilter />
            </RailIconButton>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{value === "all" ? "Filter" : `Filter: ${current}`}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Show
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as CommentFilter)}
        >
          {COMMENT_FILTERS.map((item) => (
            <DropdownMenuRadioItem key={item.value} value={item.value}>
              {item.label}
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {counts[item.value]}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * "N pending" over the list while open `@swarm` comments wait to be sent,
 * with the send action (`children`, the rail's "Send N"). The count shows
 * the pending comments (it sets the Pending filter, or clears it).
 */
export function PendingSummary({
  count,
  showing,
  onShow,
  children,
}: {
  count: number;
  /** The Pending filter is on. */
  showing: boolean;
  onShow: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle bg-status-info/5 px-3 py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-pressed={showing}
            onClick={onShow}
            className="flex items-center gap-1.5 rounded-sm text-xs font-medium text-status-info-strong underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <PendingDot />
            {count} pending
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {showing ? "Show all comments" : "Show the @swarm comments not sent yet"}
        </TooltipContent>
      </Tooltip>
      {children}
    </div>
  );
}

/** "Mine: 2 of 5" (or "Showing 2 of 5" for a search alone) with "Clear filters". */
export function FilterSummary({
  filter,
  shown,
  total,
  onClear,
}: {
  filter: CommentFilter;
  shown: number;
  total: number;
  onClear: () => void;
}) {
  const label = COMMENT_FILTERS.find((item) => item.value === filter)?.label;
  return (
    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
      <span className="tabular-nums">
        {filter === "all" ? "Showing" : `${label}:`} {shown} of {total}
      </span>
      <Button size="xs" variant="ghost" className="text-muted-foreground" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}
