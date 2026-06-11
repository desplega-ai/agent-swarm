import { type ReactNode, useMemo, useState } from "react";
import { InfoTip } from "./Tooltip.tsx";

export interface Column<T> {
  key: string; // unique column id
  header: string;
  headerTip?: string; // optional "i"-tooltip on the header
  width?: string; // CSS width ("90px", "1fr"); default auto
  align?: "left" | "right" | "center"; // default "left"
  sortable?: boolean; // default true
  sortValue?: (row: T) => string | number | null; // default: searchText ?? rendered string
  filterOptions?: (rows: T[]) => string[]; // presence enables a dropdown filter
  filterValue?: (row: T) => string | string[]; // row's value(s) matched against selection
  searchText?: (row: T) => string; // contributes to the fuzzy haystack
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
  defaultSort?: { key: string; dir: "asc" | "desc" };
  emptyText?: string; // default "nothing here yet"
  maxHeight?: string; // scroll container, sticky header
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

function sortValueOf<T>(col: Column<T>, row: T): string | number | null {
  if (col.sortValue) return col.sortValue(row);
  if (col.searchText) return col.searchText(row);
  const rendered = col.render(row);
  if (typeof rendered === "string" || typeof rendered === "number") return rendered;
  return null;
}

function compareValues(a: string | number | null, b: string | number | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls last (for asc)
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

export function DataTable<T>(props: DataTableProps<T>): ReactNode {
  const { rows, columns, rowKey, onRowClick, rowHref } = props;
  const searchable = props.searchable ?? true;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(
    props.defaultSort ?? null,
  );
  const [filters, setFilters] = useState<Record<string, string>>({});

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
      if (!selected) continue;
      out = out.filter((row) => {
        const v = col.filterValue
          ? col.filterValue(row)
          : col.searchText
            ? col.searchText(row)
            : "";
        return Array.isArray(v) ? v.includes(selected) : v === selected;
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

  return (
    <div className="data-table">
      {searchable || filterCols.length > 0 ? (
        <div className="dt-bar">
          {searchable ? (
            <input
              className="dt-search"
              type="search"
              placeholder={props.searchPlaceholder ?? "search…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          ) : null}
          {filterCols.map((col) => (
            <select
              key={col.key}
              className="dt-filter"
              value={filters[col.key] ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, [col.key]: e.target.value }))}
              title={`filter by ${col.header}`}
            >
              <option value="">all</option>
              {(col.filterOptions ? col.filterOptions(rows) : []).map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ))}
        </div>
      ) : null}
      <div
        className="dt-scroll"
        style={props.maxHeight ? { maxHeight: props.maxHeight } : undefined}
      >
        <table className="data">
          <thead>
            <tr>
              {columns.map((col) => {
                const sortable = col.sortable ?? true;
                const arrow = sort?.key === col.key ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
                return (
                  <th
                    key={col.key}
                    style={col.width ? { width: col.width } : undefined}
                    className={col.align ? `align-${col.align}` : undefined}
                  >
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
                <td className="dt-empty" colSpan={columns.length}>
                  {props.emptyText ?? "nothing here yet"}
                </td>
              </tr>
            ) : (
              visible.map((row) => {
                const key = rowKey(row);
                const href = rowHref?.(row) ?? null;
                const clickable = href !== null || onRowClick !== undefined;
                const cls = [
                  key === props.selectedKey ? "selected" : "",
                  clickable ? "clickable" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                const handleClick = href === null && onRowClick ? () => onRowClick(row) : undefined;
                return (
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
                  >
                    {columns.map((col) => (
                      <td key={col.key} className={col.align ? `align-${col.align}` : undefined}>
                        {href !== null ? (
                          <a className="dt-row-link" href={href}>
                            {col.render(row)}
                          </a>
                        ) : (
                          col.render(row)
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
