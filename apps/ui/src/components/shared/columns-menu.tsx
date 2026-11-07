import { ChevronDown, Settings2 } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { DataGridColumnsState } from "@/components/shared/data-grid";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface ColumnsMenuItem {
  id: string;
  label: ReactNode;
  checked: boolean;
  disabled?: boolean;
  className?: string;
  /** Right-aligned hint, e.g. "locked". */
  note?: ReactNode;
  onCheckedChange?: (checked: boolean) => void;
}

/**
 * The "Columns" dropdown shared by the tasks table and every `DataGrid` with
 * toggleable columns. Each group renders between separators.
 */
export function ColumnsMenu({
  groups,
  hiddenCount = 0,
  trigger,
}: {
  groups: ColumnsMenuItem[][];
  /** Shown on the trigger so users know columns are missing. */
  hiddenCount?: number;
  trigger?: ReactNode;
}) {
  const visibleGroups = groups.filter((group) => group.length > 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" />
            Columns
            {hiddenCount > 0 ? (
              <span className="rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">
                {hiddenCount} hidden
              </span>
            ) : null}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs">Show columns</DropdownMenuLabel>
        {visibleGroups.map((group) => (
          <Fragment key={group[0].id}>
            <DropdownMenuSeparator />
            {group.map((item) => (
              <DropdownMenuCheckboxItem
                key={item.id}
                checked={item.checked}
                disabled={item.disabled}
                className={item.className}
                onCheckedChange={(checked) => item.onCheckedChange?.(Boolean(checked))}
              >
                {item.label}
                {item.note ? (
                  <span className="ml-auto text-[10px] text-muted-foreground">{item.note}</span>
                ) : null}
              </DropdownMenuCheckboxItem>
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Columns menu for a `DataGrid` that receives the same `columns` state.
 * Columns the grid hid to fit show unchecked; checking one forces it visible
 * (the grid scrolls horizontally), unchecking hides it.
 */
export function DataGridColumnsMenu({
  state,
  compact = false,
}: {
  state: DataGridColumnsState;
  /** An icon-only trigger for a crowded toolbar row. */
  compact?: boolean;
}) {
  const pinned = state.entries.filter((entry) => !entry.toggleable);
  const toggleable = state.entries.filter((entry) => entry.toggleable);
  const label = state.hiddenCount > 0 ? `Columns, ${state.hiddenCount} hidden` : "Columns";
  return (
    <ColumnsMenu
      hiddenCount={state.hiddenCount}
      trigger={
        compact ? (
          <Button
            variant="outline"
            size="icon-sm"
            className="size-8 shrink-0"
            aria-label={label}
            title={label}
          >
            <Settings2 className="size-4" />
          </Button>
        ) : undefined
      }
      groups={[
        pinned.map((entry) => ({
          id: entry.id,
          label: entry.label,
          checked: true,
          disabled: true,
          className: "opacity-60",
        })),
        toggleable.map((entry) => ({
          id: entry.id,
          label: entry.label,
          checked: entry.visible,
          onCheckedChange: (checked: boolean) => state.setVisible(entry.id, checked),
        })),
      ]}
    />
  );
}
