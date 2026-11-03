/**
 * Built-in column filters for the swarm-apps `Table` (`filterable` / `columns[].filter`).
 *
 * The filter state is plain client state under `/ui/<table id>/filters`, one
 * entry per filtered column: a string array for a `values` filter ("cell is one
 * of", what the header menu's checkbox list writes) or a string for a `text`
 * filter ("cell contains"). Other elements can bind it, e.g.
 * `{ "$state": "/ui/prTable/filters/ci" }`.
 *
 * Everything here is pure so the rules (which columns get which menu, the
 * faceted counts, the AND across columns) are unit-testable without AG Grid or
 * a DOM. Values are compared as the strings `filterKey` produces, so a numeric
 * `7` and the string `"7"` are one value and a boolean cell is `"true"` /
 * `"false"`.
 */

export type ColumnFilterMode = "values" | "text";
export type FilterValue = string[] | string;
export type ColumnFilters = Record<string, FilterValue>;

/** The slice of a Table column the filter rules read. */
export interface FilterColumn {
  key: string;
  label?: string;
  kind?: string;
  format?: string;
  filter?: ColumnFilterMode | false;
  /** Values rendered as a muted dash instead of a pill. */
  muted?: readonly string[];
}

/** Reads the value one row shows in one column. */
export type CellReader = (row: Record<string, unknown>, column: FilterColumn) => unknown;

/** Column kinds whose cells are a small set of repeated values, so a checkbox list suits them. */
const VALUE_KINDS: ReadonlySet<string | undefined> = new Set([
  "badge",
  "status",
  "enum",
  "boolean",
  "user",
  "agent",
]);
/** Free-text kinds; a column with no kind is text too. */
const TEXT_KINDS: ReadonlySet<string | undefined> = new Set([undefined, "text", "string"]);

export function toFilterBoolean(cell: unknown): boolean {
  if (typeof cell === "boolean") return cell;
  if (typeof cell === "number") return cell !== 0;
  if (typeof cell === "string") return cell === "true" || cell === "1";
  return false;
}

/**
 * Which menu a column's header gets, or `null` for none. An explicit
 * `filter` always wins (so one column can opt in without `filterable`);
 * otherwise `filterable` picks by kind. A `format` column has no single source
 * value, so it only filters when the author asks for it.
 */
export function columnFilterMode(
  column: FilterColumn,
  tableFilterable: boolean,
): ColumnFilterMode | null {
  if (column.filter === false) return null;
  if (column.filter === "values" || column.filter === "text") return column.filter;
  if (!tableFilterable || column.format) return null;
  if (VALUE_KINDS.has(column.kind)) return "values";
  if (TEXT_KINDS.has(column.kind)) return "text";
  return null;
}

/**
 * The comparable string for one cell: `""` for nothing, `"true"` / `"false"` for
 * a `boolean` column. A boolean column reads exactly as `formatValue` renders it
 * (null / undefined is blank, anything else is its truthiness), so the filter
 * list, its counts and the match never disagree with what the cell shows.
 */
export function filterKey(column: FilterColumn, cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (column.kind === "boolean") return cell ? "true" : "false";
  if (typeof cell === "object") return JSON.stringify(cell);
  return String(cell);
}

/** How a value reads in the checkbox list and on a pill. */
export function filterValueLabel(column: FilterColumn, key: string): string {
  if (key === "") return "(empty)";
  if (column.kind === "boolean") return key === "true" ? "Yes" : "No";
  return key;
}

/** A `muted` value renders as a dash instead of a pill (case-insensitive). */
export function isMutedValue(column: Pick<FilterColumn, "muted">, value: unknown): boolean {
  if (!column.muted || column.muted.length === 0) return false;
  if (value === null || value === undefined || value === "") return false;
  const needle = String(value).toLowerCase();
  return column.muted.some((entry) => entry.toLowerCase() === needle);
}

// ─── State ──────────────────────────────────────────────────────────────────

/**
 * The state slot as a clean filter map: unknown columns, junk and empty
 * entries are dropped, so a hand-written or stale `/ui/<id>/filters` never
 * reaches the matcher.
 */
export function filtersFromState(
  value: unknown,
  modes: ReadonlyMap<string, ColumnFilterMode>,
): ColumnFilters {
  const out: ColumnFilters = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    const mode = modes.get(key);
    if (!mode) continue;
    if (mode === "values") {
      const list = Array.isArray(entry)
        ? entry
        : typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
          ? [entry]
          : [];
      const clean = [
        ...new Set(
          list
            .filter((item) => ["string", "number", "boolean"].includes(typeof item))
            .map((item) => String(item)),
        ),
      ];
      if (clean.length > 0) out[key] = clean;
    } else if (typeof entry === "string" && entry.trim() !== "") {
      out[key] = entry;
    }
  }
  return out;
}

export function activeFilterCount(filters: ColumnFilters): number {
  return Object.keys(filters).length;
}

/** One value on or off in a `values` filter; the entry disappears when it empties. */
export function toggleFilterValue(
  filters: ColumnFilters,
  key: string,
  value: string,
  checked: boolean,
): ColumnFilters {
  const current = Array.isArray(filters[key]) ? (filters[key] as string[]) : [];
  const next = checked
    ? current.includes(value)
      ? current
      : [...current, value]
    : current.filter((entry) => entry !== value);
  return withEntry(filters, key, next.length > 0 ? next : undefined);
}

/** Replaces a `text` filter; blank clears it. */
export function setFilterText(filters: ColumnFilters, key: string, text: string): ColumnFilters {
  return withEntry(filters, key, text.trim() === "" ? undefined : text);
}

export function clearFilter(filters: ColumnFilters, key: string): ColumnFilters {
  return withEntry(filters, key, undefined);
}

function withEntry(
  filters: ColumnFilters,
  key: string,
  value: FilterValue | undefined,
): ColumnFilters {
  const next: ColumnFilters = { ...filters };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

// ─── Matching ───────────────────────────────────────────────────────────────

function rowMatchesColumn(
  row: Record<string, unknown>,
  column: FilterColumn,
  filter: FilterValue,
  read: CellReader,
): boolean {
  const cell = read(row, column);
  if (Array.isArray(filter)) return filter.includes(filterKey(column, cell));
  return filterKey(column, cell).toLowerCase().includes(filter.trim().toLowerCase());
}

/**
 * Rows that pass every active column filter (AND across columns, OR within a
 * `values` filter). `skip` leaves one column out, which is how a column's own
 * facet counts ignore its own selection.
 */
export function applyColumnFilters(
  rows: readonly Record<string, unknown>[],
  filters: ColumnFilters,
  columns: ReadonlyMap<string, FilterColumn>,
  read: CellReader,
  skip?: string,
): Record<string, unknown>[] {
  const active = Object.entries(filters).filter(([key]) => key !== skip && columns.has(key));
  if (active.length === 0) return rows as Record<string, unknown>[];
  return rows.filter((row) =>
    active.every(([key, filter]) => rowMatchesColumn(row, columns.get(key)!, filter, read)),
  );
}

export interface FacetOption {
  /** What the filter stores (`filterKey`). */
  value: string;
  label: string;
  count: number;
}

/**
 * The distinct values of one column with how many of `rows` carry each, sorted
 * by label (numeric-aware). `universe` (default `rows`) decides which values
 * are listed at all, so a list stays the same length while other filters change
 * its counts; a value no row carries shows 0. Selected values the data no
 * longer has stay in the list too, so the user can still untick them.
 */
export function facetOptions(
  rows: readonly Record<string, unknown>[],
  column: FilterColumn,
  read: CellReader,
  selected: readonly string[] = [],
  universe: readonly Record<string, unknown>[] = rows,
): FacetOption[] {
  const counts = new Map<string, number>();
  for (const row of universe) counts.set(filterKey(column, read(row, column)), 0);
  for (const row of rows) {
    const key = filterKey(column, read(row, column));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const key of selected) if (!counts.has(key)) counts.set(key, 0);
  return [...counts]
    .map(([value, count]) => ({ value, label: filterValueLabel(column, value), count }))
    .sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }),
    );
}

/**
 * The whole pipeline in one call: the rows left after the column filters, and
 * each `values` column's facet list (counted over the rows that pass every
 * filter EXCEPT that column's own, so ticking a second value shows what it adds).
 */
export function narrowByColumnFilters(
  rows: readonly Record<string, unknown>[],
  filters: ColumnFilters,
  columns: ReadonlyMap<string, FilterColumn>,
  modes: ReadonlyMap<string, ColumnFilterMode>,
  read: CellReader,
): { rows: Record<string, unknown>[]; facets: Record<string, FacetOption[]> } {
  const facets: Record<string, FacetOption[]> = {};
  for (const [key, mode] of modes) {
    const column = columns.get(key);
    if (mode !== "values" || !column) continue;
    const selected = Array.isArray(filters[key]) ? (filters[key] as string[]) : [];
    facets[key] = facetOptions(
      applyColumnFilters(rows, filters, columns, read, key),
      column,
      read,
      selected,
      rows,
    );
  }
  return { rows: applyColumnFilters(rows, filters, columns, read), facets };
}

// ─── Pills ──────────────────────────────────────────────────────────────────

export interface FilterPill {
  key: string;
  /** Column label, e.g. "CI on head". */
  column: string;
  /** The filter in words: `green, red` or `contains "fix"`. */
  text: string;
}

/** Values shown on a pill before it folds the rest into `+N`. */
const PILL_VALUES = 2;

/** One removable pill per active filter, in column order. */
export function filterPills(
  filters: ColumnFilters,
  columns: readonly FilterColumn[],
): FilterPill[] {
  const pills: FilterPill[] = [];
  for (const column of columns) {
    const filter = filters[column.key];
    if (filter === undefined) continue;
    const name = column.label ?? column.key;
    if (Array.isArray(filter)) {
      const shown = filter.slice(0, PILL_VALUES).map((value) => filterValueLabel(column, value));
      const more = filter.length - shown.length;
      pills.push({
        key: column.key,
        column: name,
        text: more > 0 ? `${shown.join(", ")} +${more}` : shown.join(", "),
      });
    } else {
      pills.push({ key: column.key, column: name, text: `contains "${filter.trim()}"` });
    }
  }
  return pills;
}
