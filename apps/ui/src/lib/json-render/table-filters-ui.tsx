/**
 * The visible parts of the `Table`'s built-in column filters: the header menu
 * (checkbox list with counts, or a contains-text field), the removable pills
 * above the table, and the phone "Filters" button.
 *
 * Like row selection, AG Grid keeps column defs stable across the 5s poll, so
 * the header cannot take the filter state as props. It subscribes to a small
 * per-table store instead (`createFilterStore`); the Table pushes the active
 * filters and the faceted counts in, and the store hands edits back.
 */

import { ListFilter, X } from "lucide-react";
import { type ReactNode, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { CatalogIcon } from "./icons";
import type { ColumnFilterMode, ColumnFilters, FacetOption, FilterPill } from "./table-filters";
import { TableCheckbox } from "./table-selection-ui";
import { OverflowTip } from "./tip";

// ─── Per-table filter store ─────────────────────────────────────────────────

export interface FilterSnapshot {
  filters: ColumnFilters;
  /** Distinct values with counts, for each `values` column. */
  facets: Record<string, FacetOption[]>;
}

/** What the header menus call back into; the Table swaps these in on every render. */
export interface FilterHandlers {
  toggle: (key: string, value: string, checked: boolean) => void;
  setText: (key: string, text: string) => void;
  clear: (key: string) => void;
  clearAll: () => void;
}

export interface FilterStore {
  getSnapshot: () => FilterSnapshot;
  subscribe: (listener: () => void) => () => void;
  /** Replaces the snapshot; a no-op (no notification) when nothing changed. */
  update: (next: FilterSnapshot) => void;
  handlers: FilterHandlers;
  /** Theme attributes for the popover portal, which renders outside the app's theme scope. */
  themeAttr: Record<string, string>;
}

export function createFilterStore(): FilterStore {
  let snapshot: FilterSnapshot = { filters: {}, facets: {} };
  let signature = JSON.stringify(snapshot);
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (next) => {
      const nextSignature = JSON.stringify(next);
      if (nextSignature === signature) return;
      signature = nextSignature;
      snapshot = next;
      for (const listener of listeners) listener();
    },
    handlers: { toggle: () => {}, setText: () => {}, clear: () => {}, clearAll: () => {} },
    themeAttr: {},
  };
}

function useFilterSnapshot(store: FilterStore): FilterSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

// ─── Filter panel (the body of the header menu and of the phone sheet) ──────

/** Past this many distinct values the checkbox list gets its own search field. */
const SEARCHABLE_AFTER = 8;

export interface ColumnFilterTarget {
  key: string;
  label: string;
  mode: ColumnFilterMode;
  /** Only `kind: "boolean"` columns read Yes / No. */
  kind?: string;
  /** How a value reads in the checkbox list; the Table passes the column's pill for badge / status. */
  renderValue?: (value: string, label: string) => ReactNode;
}

function ValuesPanel({
  target,
  store,
  autoFocus,
}: {
  target: ColumnFilterTarget;
  store: FilterStore;
  autoFocus?: boolean;
}) {
  const { filters, facets } = useFilterSnapshot(store);
  const [query, setQuery] = useState("");
  const options = facets[target.key] ?? [];
  const selected = useMemo(
    () => new Set(Array.isArray(filters[target.key]) ? (filters[target.key] as string[]) : []),
    [filters, target.key],
  );
  const needle = query.trim().toLowerCase();
  const shown = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {options.length > SEARCHABLE_AFTER ? (
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Find in ${target.label}…`}
          aria-label={`Find a ${target.label} value`}
          className="h-8 text-sm"
          autoFocus={autoFocus}
        />
      ) : null}
      <ul aria-label={`${target.label} values`} className="flex max-h-64 flex-col overflow-y-auto">
        {shown.map((option) => (
          <li key={option.value}>
            <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60">
              <TableCheckbox
                checked={selected.has(option.value)}
                label={`${option.label}, ${option.count} ${option.count === 1 ? "row" : "rows"}`}
                onToggle={() =>
                  store.handlers.toggle(target.key, option.value, !selected.has(option.value))
                }
              />
              <span className="min-w-0 flex-1 truncate">
                {target.renderValue ? target.renderValue(option.value, option.label) : option.label}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">{option.count}</span>
            </label>
          </li>
        ))}
        {shown.length === 0 ? (
          <li className="px-2 py-3 text-center text-xs text-muted-foreground">
            {options.length === 0 ? "No values yet" : "No values match"}
          </li>
        ) : null}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t border-border-subtle pt-2">
        <span className="text-xs text-muted-foreground tabular-nums">
          {selected.size > 0 ? `${selected.size} selected` : "Showing all"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={selected.size === 0}
          onClick={() => store.handlers.clear(target.key)}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}

function TextPanel({
  target,
  store,
  autoFocus,
}: {
  target: ColumnFilterTarget;
  store: FilterStore;
  autoFocus?: boolean;
}) {
  const { filters } = useFilterSnapshot(store);
  const value = typeof filters[target.key] === "string" ? (filters[target.key] as string) : "";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Input
        value={value}
        onChange={(event) => store.handlers.setText(target.key, event.target.value)}
        placeholder="Contains…"
        aria-label={`${target.label} contains`}
        className="h-8 text-sm"
        autoFocus={autoFocus}
      />
      <div className="flex justify-end border-t border-border-subtle pt-2">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          disabled={value === ""}
          onClick={() => store.handlers.clear(target.key)}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}

/** One column's filter controls; the header popover and the phone sheet both render this. */
export function ColumnFilterPanel(props: {
  target: ColumnFilterTarget;
  store: FilterStore;
  autoFocus?: boolean;
}) {
  return props.target.mode === "values" ? <ValuesPanel {...props} /> : <TextPanel {...props} />;
}

// ─── Grid header ────────────────────────────────────────────────────────────

function ColumnFilterMenu({ target, store }: { target: ColumnFilterTarget; store: FilterStore }) {
  const { filters } = useFilterSnapshot(store);
  const active = filters[target.key] !== undefined;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Filter ${target.label}${active ? " (active)" : ""}`}
          data-active={active ? "true" : undefined}
          className={cn(
            "relative ml-0.5 size-5 shrink-0 text-muted-foreground hover:text-foreground",
            active && "text-primary hover:text-primary",
          )}
          // A header click sorts; a click on the menu button must only open the menu.
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ListFilter className="size-3" aria-hidden />
          {active ? (
            <span aria-hidden className="absolute right-0 top-0 size-1.5 rounded-full bg-primary" />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2" {...store.themeAttr}>
        <ColumnFilterPanel target={target} store={store} autoFocus />
      </PopoverContent>
    </Popover>
  );
}

/**
 * AG Grid's inner header component: the label (with its optional icon) and,
 * for a filterable column, the filter menu button. AG Grid keeps sorting and
 * the resize handle around it. A label cut by the column width shows in full
 * in a tooltip, and a column `hint` adds its explanation under it.
 */
export function ColumnHeader(params: {
  displayName: string;
  icon?: string;
  hint?: string;
  store?: FilterStore;
  filter?: ColumnFilterTarget;
}) {
  const content = params.hint ? (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium">{params.displayName}</span>
      <span>{params.hint}</span>
    </span>
  ) : (
    params.displayName
  );
  return (
    <span className="flex min-w-0 items-center gap-1">
      <OverflowTip
        content={content}
        always={Boolean(params.hint)}
        className="flex min-w-0 items-center gap-1.5"
      >
        {params.icon ? (
          <CatalogIcon
            name={params.icon}
            size="sm"
            className="size-3 shrink-0 text-muted-foreground"
          />
        ) : null}
        <span className="ag-header-cell-text min-w-0">{params.displayName}</span>
      </OverflowTip>
      {params.store && params.filter ? (
        <ColumnFilterMenu target={params.filter} store={params.store} />
      ) : null}
    </span>
  );
}

// ─── Pills ──────────────────────────────────────────────────────────────────

export function FilterPills({
  pills,
  onRemove,
  onClearAll,
  className,
}: {
  pills: readonly FilterPill[];
  onRemove: (key: string) => void;
  onClearAll: () => void;
  className?: string;
}): ReactNode {
  if (pills.length === 0) return null;
  return (
    <section
      aria-label="Active filters"
      data-testid="table-filter-pills"
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {pills.map((pill) => (
        <span
          key={pill.key}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/40 py-0.5 pr-1 pl-2.5 text-xs"
        >
          <span className="shrink-0 text-muted-foreground">{pill.column}</span>
          <span className="min-w-0 truncate font-medium">{pill.text}</span>
          <button
            type="button"
            aria-label={`Remove ${pill.column} filter`}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            onClick={() => onRemove(pill.key)}
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs text-muted-foreground"
        onClick={onClearAll}
      >
        Clear all
      </Button>
    </section>
  );
}

// ─── Phone ──────────────────────────────────────────────────────────────────

/**
 * Below 768px the grid is a card list with no header, so the filters move into
 * one "Filters" button: a popover with a section per filterable column.
 */
export function PhoneFilterButton({
  targets,
  store,
  activeCount,
}: {
  targets: readonly ColumnFilterTarget[];
  store: FilterStore;
  activeCount: number;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="h-9 gap-1.5 self-start">
          <ListFilter className="size-3.5" aria-hidden />
          Filters
          {activeCount > 0 ? (
            <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium tabular-nums text-primary-foreground">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[70vh] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto p-3"
        // Opening must not focus the first field: on a phone that raises the keyboard over the list.
        onOpenAutoFocus={(event) => event.preventDefault()}
        {...store.themeAttr}
      >
        <div className="flex flex-col gap-4">
          {targets.map((target) => (
            <section key={target.key} className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">{target.label}</h3>
              <ColumnFilterPanel target={target} store={store} />
            </section>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
