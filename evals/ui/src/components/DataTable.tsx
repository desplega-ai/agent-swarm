import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { InfoTip, Tooltip } from "./Tooltip.tsx";

export interface Column<T> {
  key: string; // unique column id
  header: string;
  headerTip?: string; // optional "i"-tooltip on the header
  width?: string; // CSS width ("90px"); feeds the <colgroup> — table-layout is fixed
  align?: "left" | "right" | "center"; // default "left"
  sortable?: boolean; // default true
  sortValue?: (row: T) => string | number | null; // default: searchText ?? rendered string
  filterOptions?: (rows: T[]) => string[]; // presence enables a multi-select dropdown filter
  filterValue?: (row: T) => string | string[]; // row's value(s) matched against the selection
  filterRender?: (option: string) => ReactNode; // custom option rendering (e.g. harness icon)
  searchText?: (row: T) => string; // contributes to the fuzzy haystack
  titleText?: (row: T) => string; // hover-reveal title; default searchText → string render
  /** Rich portal hover (item 4: full names; item 3: matrix breakdowns). Non-null
   *  return wraps the cell in a wide portal Tooltip and suppresses the native title. */
  tooltip?: (row: T) => ReactNode | null;
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowHref?: (row: T) => string | null; // renders row as link-row (takes precedence)
  selectedKey?: string | null; // highlights row
  searchable?: boolean; // default true — fuzzy input above the table
  searchPlaceholder?: string;
  /** "stacked": row 1 = filters, row 2 = full-width search. Default "inline". */
  toolbarLayout?: "inline" | "stacked";
  defaultSort?: { key: string; dir: "asc" | "desc" };
  emptyText?: string; // default "Nothing here yet"
  maxHeight?: string; // scroll container, sticky header
  /** Row expansion (item 9): adds a leading ▸/▾ chevron column; clicking a row
   *  toggles a full-width detail row rendered by this callback. Takes precedence
   *  over onRowClick/rowHref for the row click. */
  renderExpanded?: (row: T) => ReactNode;
}

/** Case-insensitive subsequence match. */
export function fuzzyMatch(query: string, haystack: string): boolean {
  const q = query.toLowerCase();
  if (q.length === 0) return true;
  const h = haystack.toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === q[i]) i += 1;
    if (i >= q.length) return true;
  }
  return false;
}

const EDGE = 8;

/** Option count at which the dropdown grows a type-ahead search input (item 3 —
 *  the ~4-option harness dropdown stays input-free). */
const SEARCH_THRESHOLD = 8;

/**
 * Multi-select dropdown filter: button showing "Label · n ▾", portal panel with
 * checkboxes (viewport-aware, escapes any container). Empty selection = no filter.
 *
 * Round 9 (item 3): panels with >= 8 options get a type-ahead search input —
 * auto-focused on open, fuzzy-filtering live (against `searchText`, default the
 * raw option string), ArrowUp/ArrowDown + Enter toggle a highlighted option,
 * Escape clears a non-empty query first and closes on the second press.
 * Selected-but-unmatched options hide while filtering; the button count badge
 * stays authoritative.
 */
export function MultiSelect(props: {
  label: string;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  renderOption?: (option: string) => ReactNode;
  /** Fuzzy haystack per option — default the option string itself. Callers with
   *  pretty-printed entries (e.g. ConfigChip) add the resolved label/model so
   *  typing a model name matches the chip. */
  searchText?: (option: string) => string;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1); // index into `visible`; -1 = none
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const highlightRef = useRef<HTMLLabelElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPos(null);
    setQuery("");
    setHighlight(-1);
  }, []);

  const searchable = props.options.length >= SEARCH_THRESHOLD;
  const trimmed = query.trim();
  const haystackOf = props.searchText;
  const visible = useMemo(() => {
    if (!searchable || trimmed.length === 0) return props.options;
    return props.options.filter((o) => fuzzyMatch(trimmed, haystackOf ? haystackOf(o) : o));
  }, [searchable, trimmed, props.options, haystackOf]);

  useLayoutEffect(() => {
    if (!open || !btnRef.current || !panelRef.current) return;
    const anchor = btnRef.current.getBoundingClientRect();
    const panel = panelRef.current.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - EDGE - panel.width));
    let top = anchor.bottom + 4;
    if (top + panel.height > window.innerHeight - EDGE) top = anchor.top - 4 - panel.height;
    setPos({ left, top: Math.max(EDGE, top) });
  }, [open]);

  // Focus the search only once the panel is positioned — it mounts at
  // visibility:hidden and hidden elements refuse focus.
  useEffect(() => {
    if (open && pos !== null) inputRef.current?.focus();
  }, [open, pos]);

  // Keep the keyboard-highlighted option in view inside the scrolling panel.
  useEffect(() => {
    if (highlight >= 0) highlightRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const { selected, onChange } = props;
  const toggle = useCallback(
    (option: string) => {
      const next = selected.includes(option)
        ? selected.filter((o) => o !== option)
        : [...selected, option];
      onChange(next);
    },
    [selected, onChange],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Non-empty query: first Escape clears the search and keeps the panel
        // open; an empty-query Escape closes it (the pre-round-9 behavior).
        if (trimmed.length > 0) {
          setQuery("");
          setHighlight(-1);
        } else {
          close();
        }
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, visible.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter") {
        const target = visible[highlight];
        if (target !== undefined) {
          e.preventDefault();
          toggle(target);
        }
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, trimmed, visible, highlight, toggle]);

  const active = props.selected.length > 0;
  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={active ? "ms-btn active" : "ms-btn"}
        onClick={() => (open ? close() : setOpen(true))}
        title={`Filter by ${props.label}`}
      >
        {props.label}
        {active ? <span className="ms-count">{props.selected.length}</span> : null}
        <span className="ms-arrow">▾</span>
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              className="ms-menu"
              style={
                pos
                  ? { left: pos.left, top: pos.top }
                  : { left: -9999, top: -9999, visibility: "hidden" }
              }
            >
              {searchable ? (
                <div className="ms-search">
                  <input
                    ref={inputRef}
                    type="search"
                    placeholder={`Search ${props.label.toLowerCase()}…`}
                    aria-label={`Search ${props.label} options`}
                    value={query}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      // Typing pre-highlights the best (first) match so Enter
                      // toggles it straight away; clearing drops the highlight.
                      setHighlight(e.target.value.trim().length > 0 ? 0 : -1);
                    }}
                  />
                </div>
              ) : null}
              {props.options.length === 0 ? <div className="ms-empty dim">No options</div> : null}
              {props.options.length > 0 && visible.length === 0 ? (
                <div className="ms-empty dim">No options match</div>
              ) : null}
              {visible.map((option, i) => (
                <label
                  className={i === highlight ? "ms-option highlighted" : "ms-option"}
                  key={option}
                  ref={i === highlight ? highlightRef : undefined}
                >
                  <input
                    type="checkbox"
                    checked={props.selected.includes(option)}
                    onChange={() => toggle(option)}
                  />
                  <span className="ms-option-label">
                    {props.renderOption ? props.renderOption(option) : option}
                  </span>
                </label>
              ))}
              {active ? (
                <button type="button" className="ms-clear" onClick={() => props.onChange([])}>
                  Clear
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function sortValueOf<T>(col: Column<T>, row: T): string | number | null {
  if (col.sortValue) return col.sortValue(row);
  if (col.searchText) return col.searchText(row);
  const rendered = col.render(row);
  if (typeof rendered === "string" || typeof rendered === "number") return rendered;
  return null;
}

function titleOf<T>(col: Column<T>, row: T): string | undefined {
  if (col.titleText) return col.titleText(row);
  if (col.searchText) return col.searchText(row);
  const rendered = col.render(row);
  if (typeof rendered === "string") return rendered;
  if (typeof rendered === "number") return String(rendered);
  return undefined;
}

function compareValues(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls last (for asc)
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

export function DataTable<T>(props: DataTableProps<T>): ReactNode {
  const { rows, columns, rowKey, onRowClick, rowHref, renderExpanded } = props;
  const searchable = props.searchable ?? true;
  const stacked = props.toolbarLayout === "stacked";
  const expandable = renderExpanded !== undefined;
  const colCount = columns.length + (expandable ? 1 : 0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(
    props.defaultSort ?? null,
  );
  const [filters, setFilters] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filterCols = columns.filter((c) => c.filterOptions);

  const visible = useMemo(() => {
    const searchCols = columns.filter((c) => c.searchText);
    let out = rows;
    if (query.trim().length > 0 && searchCols.length > 0) {
      out = out.filter((row) =>
        fuzzyMatch(
          query.trim(),
          searchCols.map((c) => (c.searchText ? c.searchText(row) : "")).join(" "),
        ),
      );
    }
    for (const col of columns.filter((c) => c.filterOptions)) {
      const selected = filters[col.key];
      if (!selected || selected.length === 0) continue;
      out = out.filter((row) => {
        const v = col.filterValue
          ? col.filterValue(row)
          : col.searchText
            ? col.searchText(row)
            : "";
        return Array.isArray(v) ? v.some((item) => selected.includes(item)) : selected.includes(v);
      });
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        const dir = sort.dir === "asc" ? 1 : -1;
        out = [...out].sort(
          (a, b) => dir * compareValues(sortValueOf(col, a), sortValueOf(col, b)),
        );
      }
    }
    return out;
  }, [rows, columns, query, filters, sort]);

  const toggleSort = (key: string) => {
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" },
    );
  };

  const searchInput = searchable ? (
    <input
      className="dt-search"
      type="search"
      placeholder={props.searchPlaceholder ?? "Search…"}
      value={query}
      onChange={(e) => setQuery(e.target.value)}
    />
  ) : null;

  const filterControls = filterCols.map((col) => (
    <MultiSelect
      key={col.key}
      label={col.header}
      options={col.filterOptions ? col.filterOptions(rows) : []}
      selected={filters[col.key] ?? []}
      onChange={(next) => setFilters((f) => ({ ...f, [col.key]: next }))}
      renderOption={col.filterRender}
    />
  ));

  return (
    <div className="data-table">
      {searchable || filterCols.length > 0 ? (
        stacked ? (
          <div className="dt-bar stacked">
            {filterCols.length > 0 ? <div className="dt-filters">{filterControls}</div> : null}
            {searchInput}
          </div>
        ) : (
          <div className="dt-bar">
            {searchInput}
            {filterControls}
          </div>
        )
      ) : null}
      <div
        className="dt-scroll"
        style={props.maxHeight ? { maxHeight: props.maxHeight } : undefined}
      >
        <table className="data">
          <colgroup>
            {expandable ? <col style={{ width: "26px" }} /> : null}
            {columns.map((col) => (
              <col key={col.key} style={col.width ? { width: col.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {expandable ? <th aria-label="Expand" /> : null}
              {columns.map((col) => {
                const sortable = col.sortable ?? true;
                const arrow = sort?.key === col.key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
                return (
                  <th key={col.key} className={col.align ? `align-${col.align}` : undefined}>
                    {sortable ? (
                      <button type="button" className="dt-sort" onClick={() => toggleSort(col.key)}>
                        {col.header}
                        {arrow}
                      </button>
                    ) : (
                      col.header
                    )}
                    {col.headerTip ? <InfoTip text={col.headerTip} /> : null}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td className="dt-empty" colSpan={colCount}>
                  {props.emptyText ?? "Nothing here yet"}
                </td>
              </tr>
            ) : (
              visible.map((row) => {
                const key = rowKey(row);
                const href = expandable ? null : (rowHref?.(row) ?? null);
                const isExpanded = expandable && expanded.has(key);
                const clickable = expandable || href !== null || onRowClick !== undefined;
                const cls = [
                  key === props.selectedKey ? "selected" : "",
                  clickable ? "clickable" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                const handleClick = expandable
                  ? () => toggleExpanded(key)
                  : href === null && onRowClick
                    ? () => onRowClick(row)
                    : undefined;
                const mainRow = (
                  <tr
                    key={key}
                    className={cls || undefined}
                    onClick={handleClick}
                    onKeyDown={
                      handleClick
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleClick();
                            }
                          }
                        : undefined
                    }
                    tabIndex={handleClick ? 0 : undefined}
                    aria-expanded={expandable ? isExpanded : undefined}
                  >
                    {expandable ? (
                      <td className="align-center">
                        <span className="dt-chevron" aria-hidden>
                          {isExpanded ? "▾" : "▸"}
                        </span>
                      </td>
                    ) : null}
                    {columns.map((col) => {
                      const tip = col.tooltip?.(row) ?? null;
                      const cell = (
                        <div
                          className="dt-cell"
                          title={tip === null ? titleOf(col, row) : undefined}
                        >
                          {col.render(row)}
                        </div>
                      );
                      const wrapped =
                        tip !== null ? (
                          <Tooltip block wide text={tip}>
                            {cell}
                          </Tooltip>
                        ) : (
                          cell
                        );
                      return (
                        <td key={col.key} className={col.align ? `align-${col.align}` : undefined}>
                          {href !== null ? (
                            <a className="dt-row-link" href={href}>
                              {wrapped}
                            </a>
                          ) : (
                            wrapped
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
                if (!isExpanded || renderExpanded === undefined) return mainRow;
                return (
                  <Fragment key={key}>
                    {mainRow}
                    <tr className="dt-expand-row">
                      <td colSpan={colCount}>{renderExpanded(row)}</td>
                    </tr>
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
