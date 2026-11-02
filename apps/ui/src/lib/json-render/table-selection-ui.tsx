/**
 * The visible parts of `Table` row selection: the shared checkbox primitive,
 * the grid's select cell and select-all header, and the bulk-action bar.
 *
 * `TableCheckbox` is the one checkbox every table control builds on (the
 * selection column today, column filters next): tri-state, reports shift on
 * click, never lets the click reach the row.
 *
 * AG Grid keeps column defs stable across the 5s poll, so the select cell and
 * header cannot take the selection as props. They subscribe to a small
 * per-table store instead (`createSelectionStore`); the Table pushes the
 * selection and the visible ids into it, and the store hands toggles back.
 */

import type { GridApi } from "ag-grid-community";
import { type ReactNode, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { TableBulkAction } from "./catalog";
import { CatalogIcon } from "./icons";
import { type CheckState, headerCheckState, sameSelection } from "./table-selection";

// ─── Shared checkbox primitive ──────────────────────────────────────────────

export interface TableCheckboxProps {
  checked: CheckState;
  /** Fires on every click with whether shift was held (range select). */
  onToggle: (event: { shiftKey: boolean }) => void;
  /** Accessible name; a bare checkbox has none. */
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Controlled checkbox for table cells and headers. The click is swallowed
 * here (`stopPropagation`), so a row's `onRowClick` never fires from it.
 */
export function TableCheckbox({
  checked,
  onToggle,
  label,
  disabled,
  className,
}: TableCheckboxProps) {
  return (
    <Checkbox
      checked={checked}
      disabled={disabled}
      aria-label={label}
      className={className}
      onClick={(event) => {
        event.stopPropagation();
        onToggle({ shiftKey: event.shiftKey });
      }}
    />
  );
}

// ─── Per-table selection store ──────────────────────────────────────────────

export interface SelectionSnapshot {
  selected: ReadonlySet<string>;
  /** Ids of the rows left after `search` / `filters`, in data order. */
  visibleIds: readonly string[];
}

/** What the select cell and header call back into; the Table swaps these in on every render. */
export interface SelectionHandlers {
  /** `displayOrder` is set on a shift-click: the grid's current row order, for the range. */
  toggleRow: (id: string, checked: boolean, displayOrder: readonly string[] | null) => void;
  toggleAll: () => void;
}

export interface SelectionStore {
  getSnapshot: () => SelectionSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Replaces the snapshot; a no-op (no notification) when nothing changed. */
  update: (next: { selected: readonly string[]; visibleIds: readonly string[] }) => void;
  handlers: SelectionHandlers;
  rowId: (row: Record<string, unknown>) => string;
  /** Accessible name of one row's checkbox. */
  rowLabel: (row: Record<string, unknown>) => string;
}

export function createSelectionStore(): SelectionStore {
  let snapshot: SelectionSnapshot = { selected: new Set(), visibleIds: [] };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (next) => {
      const current = [...snapshot.selected];
      if (
        sameSelection(current, next.selected) &&
        sameSelection(snapshot.visibleIds, next.visibleIds)
      ) {
        return;
      }
      snapshot = { selected: new Set(next.selected), visibleIds: [...next.visibleIds] };
      for (const listener of listeners) listener();
    },
    handlers: { toggleRow: () => {}, toggleAll: () => {} },
    rowId: (row) => JSON.stringify(row),
    rowLabel: () => "Select row",
  };
}

function useSelectionSnapshot(store: SelectionStore): SelectionSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Ids of the rows in the order the grid shows them now (sorted, filtered; the current page). */
function gridDisplayOrder(api: GridApi<Record<string, unknown>>, store: SelectionStore): string[] {
  const ids: string[] = [];
  for (let index = 0; index < api.getDisplayedRowCount(); index++) {
    const data = api.getDisplayedRowAtIndex(index)?.data;
    if (data) ids.push(store.rowId(data));
  }
  return ids;
}

// ─── Grid cell and header ───────────────────────────────────────────────────

/** Column id of the selection column; `grid-row-click.ts` keeps clicks in it from opening a row. */
export const SELECT_COLUMN_ID = "__select";

export function SelectCell({
  store,
  data,
  api,
}: {
  store: SelectionStore;
  data: Record<string, unknown> | undefined;
  api: GridApi<Record<string, unknown>>;
}) {
  const { selected } = useSelectionSnapshot(store);
  if (!data) return null;
  const id = store.rowId(data);
  const checked = selected.has(id);
  return (
    <div className="flex h-full w-full select-none items-center justify-center">
      <TableCheckbox
        checked={checked}
        label={store.rowLabel(data)}
        onToggle={({ shiftKey }) =>
          store.handlers.toggleRow(id, !checked, shiftKey ? gridDisplayOrder(api, store) : null)
        }
      />
    </div>
  );
}

export function SelectAllHeader({ store }: { store: SelectionStore }) {
  const { selected, visibleIds } = useSelectionSnapshot(store);
  return (
    <div className="flex h-full w-full items-center justify-center">
      <TableCheckbox
        checked={headerCheckState(visibleIds, selected)}
        disabled={visibleIds.length === 0}
        label="Select all rows"
        onToggle={() => store.handlers.toggleAll()}
      />
    </div>
  );
}

// ─── Bulk-action bar ────────────────────────────────────────────────────────

export interface BulkActionBarProps {
  count: number;
  /** Selected rows a search or filter currently hides. */
  hidden: number;
  actions: readonly TableBulkAction[];
  /** A bulk chain is in flight: the buttons wait. */
  busy?: boolean;
  onRun: (index: number) => void;
  onClear: () => void;
  className?: string;
}

/**
 * "N selected", the author's actions and Clear. Rendered only while the
 * selection is non-empty (the Table decides); it sticks to the bottom of the
 * viewport so a long table never hides it, and it sits below the grid so
 * showing it never moves a row under the pointer.
 */
export function BulkActionBar({
  count,
  hidden,
  actions,
  busy,
  onRun,
  onClear,
  className,
}: BulkActionBarProps): ReactNode {
  return (
    <section
      aria-label="Selection actions"
      data-testid="table-bulk-bar"
      className={cn(
        "sticky bottom-3 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-3 py-2 shadow-lg",
        className,
      )}
    >
      <span aria-live="polite" className="text-sm font-medium tabular-nums">
        {count} selected
        {hidden > 0 ? (
          <span className="ml-1.5 font-normal text-muted-foreground">({hidden} hidden)</span>
        ) : null}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {actions.map((action, index) => (
          <Button
            key={`${index}-${action.label}`}
            size="sm"
            variant={action.variant ?? "outline"}
            disabled={busy}
            onClick={() => onRun(index)}
          >
            <CatalogIcon name={action.icon} size="sm" />
            {action.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClear}>
          Clear
        </Button>
      </div>
    </section>
  );
}
