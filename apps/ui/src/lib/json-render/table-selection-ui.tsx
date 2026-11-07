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
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { resolveScopedParams } from "./action-params";
import type { TableBulkAction } from "./catalog";
import { CatalogIcon } from "./icons";
import {
  type BulkBinding,
  type CheckState,
  dropActedIds,
  headerCheckState,
  runBulkChain,
  sameSelection,
  selectionFromState,
} from "./table-selection";

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
  /** A bulk chain is running: the selection cannot change until it settles. */
  locked: boolean;
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
  update: (next: {
    selected: readonly string[];
    visibleIds: readonly string[];
    locked?: boolean;
  }) => void;
  handlers: SelectionHandlers;
  rowId: (row: Record<string, unknown>) => string;
  /** Accessible name of one row's checkbox. */
  rowLabel: (row: Record<string, unknown>) => string;
}

export function createSelectionStore(): SelectionStore {
  let snapshot: SelectionSnapshot = { selected: new Set(), visibleIds: [], locked: false };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (next) => {
      const current = [...snapshot.selected];
      const locked = next.locked ?? false;
      if (
        sameSelection(current, next.selected) &&
        sameSelection(snapshot.visibleIds, next.visibleIds) &&
        snapshot.locked === locked
      ) {
        return;
      }
      snapshot = { selected: new Set(next.selected), visibleIds: [...next.visibleIds], locked };
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
  const { selected, locked } = useSelectionSnapshot(store);
  if (!data) return null;
  const id = store.rowId(data);
  const checked = selected.has(id);
  return (
    <div className="flex h-full w-full select-none items-center justify-center">
      <TableCheckbox
        checked={checked}
        label={store.rowLabel(data)}
        disabled={locked}
        onToggle={({ shiftKey }) =>
          store.handlers.toggleRow(id, !checked, shiftKey ? gridDisplayOrder(api, store) : null)
        }
      />
    </div>
  );
}

export function SelectAllHeader({ store }: { store: SelectionStore }) {
  const { selected, visibleIds, locked } = useSelectionSnapshot(store);
  return (
    <div className="flex h-full w-full items-center justify-center">
      <TableCheckbox
        checked={headerCheckState(visibleIds, selected)}
        disabled={locked || visibleIds.length === 0}
        label="Select all rows"
        onToggle={() => store.handlers.toggleAll()}
      />
    </div>
  );
}

// ─── Bulk runner ────────────────────────────────────────────────────────────

export interface BulkRunnerDeps {
  actions: readonly TableBulkAction[];
  selectionPath: string;
  /** State path an `app.mutate` step reports its result to. */
  outcomePath: string;
  execute: (binding: BulkBinding) => Promise<void>;
  getSnapshot: () => Record<string, unknown>;
  get: (path: string) => unknown;
  set: (path: string, value: unknown) => void;
  /** The chain finished clean and the acted-on rows left the selection. */
  onSettled?: () => void;
  /** Task poll interval; the default suits the runtime's own task polling. */
  pollMs?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs one bulk action at a time against a frozen selection.
 *
 * While a chain runs the selection is locked (`busy`; `busyRef` for handlers
 * that must refuse at once). The chain reads the same ids at every step, and
 * on success only the rows it acted on leave the selection. On a failed step
 * (including a task that fails after its handler returned) or an unmount the
 * selection stays exactly as the user left it, so they can retry.
 */
export function useBulkRunner(deps: BulkRunnerDeps) {
  const latest = useRef(deps);
  latest.current = deps;
  const busyRef = useRef(false);
  const unmounted = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  const run = useCallback(async (index: number) => {
    if (busyRef.current) return;
    const d = latest.current;
    const action = d.actions[index];
    if (!action) return;
    const acted = selectionFromState(d.get(d.selectionPath));
    busyRef.current = true;
    setBusy(true);
    try {
      const outcome = await runBulkChain({
        chain: action.actions as BulkBinding[],
        outcomePath: d.outcomePath,
        execute: (binding, extra) =>
          latest.current.execute({
            ...binding,
            params: {
              ...resolveScopedParams(binding.params, { state: latest.current.getSnapshot() }),
              ...extra,
            },
          }),
        read: (path) => latest.current.get(path),
        write: (path, value) => latest.current.set(path, value),
        cancelled: () => unmounted.current,
        sleep: wait,
        pollMs: d.pollMs,
      });
      if (outcome === "ok") {
        const current = selectionFromState(latest.current.get(d.selectionPath));
        latest.current.set(d.selectionPath, dropActedIds(current, acted));
        latest.current.onSettled?.();
      }
    } finally {
      busyRef.current = false;
      if (!unmounted.current) setBusy(false);
    }
  }, []);

  return { busy, busyRef, run };
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
        "sticky bottom-3 z-10 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-3 py-2 shadow-lg md:flex md:flex-wrap",
        className,
      )}
    >
      <span aria-live="polite" className="text-sm font-medium tabular-nums">
        {count} selected
        {hidden > 0 ? (
          <span className="ml-1.5 font-normal text-muted-foreground">({hidden} hidden)</span>
        ) : null}
      </span>
      {/* Phone: a grid with the count and Clear on line one, the actions on line
          two. From md up both wrappers dissolve into one right-aligned row. */}
      <div className="contents md:ml-auto md:flex md:flex-wrap md:items-center md:gap-2">
        {actions.length > 0 ? (
          <div className="col-span-2 row-start-2 flex flex-wrap items-center gap-2 md:contents">
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
          </div>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="col-start-2 row-start-1"
          disabled={busy}
          onClick={onClear}
        >
          Clear
        </Button>
      </div>
    </section>
  );
}
