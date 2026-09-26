import { ListFilter } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * One "Filters (n)" button that holds a list's facet selects, so the toolbar
 * keeps a single row: search, Filters, then the page actions. `activeCount`
 * is how many facets differ from their default. Children stack vertically;
 * wrap each control in `FilterField` for a label.
 */
export function FiltersPopover({
  activeCount,
  children,
  footer,
  className,
}: {
  activeCount: number;
  children: ReactNode;
  /** Optional row under the fields, e.g. a toggle or "Clear filters". */
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("shrink-0 gap-1.5", className)}
          aria-label={activeCount > 0 ? `Filters, ${activeCount} active` : "Filters"}
        >
          <ListFilter className="size-4" />
          Filters
          {activeCount > 0 ? (
            <span className="rounded-sm bg-muted px-1.5 font-mono text-[11px] tabular-nums text-foreground">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-72 flex-col gap-3">
        {children}
        {footer ? <div className="border-t border-border pt-3">{footer}</div> : null}
      </PopoverContent>
    </Popover>
  );
}

export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col border-0 p-0">
      <legend className="mb-1.5 p-0 text-xs font-medium text-muted-foreground">{label}</legend>
      {children}
    </fieldset>
  );
}
