import { type ReactNode, useMemo } from "react";
import { Tooltip } from "../Tooltip.tsx";
import "./charts.css";

export interface HeatCellData {
  /** Drives the color scale; null = uncolored (display still shown). */
  value: number | null;
  display: ReactNode;
  /** Optional portal-Tooltip content. */
  tip?: ReactNode;
}

function defaultColorFor(t: number): string {
  // amber ramp: t=0 → barely tinted, t=1 → strong tint (readable in both themes)
  const transparent = Math.round(88 - t * 60);
  return `color-mix(in oklab, var(--accent), transparent ${transparent}%)`;
}

/**
 * Matrix with color-scaled cells (v5 spec §2.3 — FROZEN props). Standalone
 * table in the Matrix style — not DataTable-based. Normalization is linear
 * over the non-null value range; a single distinct value normalizes to 0.5.
 */
export function HeatTable(props: {
  rows: { key: string; label: ReactNode }[];
  cols: { key: string; label: ReactNode }[];
  /** null → "no data" cell (dim "—"). */
  cell: (rowKey: string, colKey: string) => HeatCellData | null;
  /** t ∈ [0,1] → CSS color. Default: amber color-mix ramp. */
  colorFor?: (t: number) => string;
  emptyText?: string;
}): ReactNode {
  const colorFor = props.colorFor ?? defaultColorFor;

  const grid = useMemo(
    () => props.rows.map((row) => props.cols.map((col) => props.cell(row.key, col.key))),
    [props.rows, props.cols, props.cell],
  );

  const { min, max, hasAny } = useMemo(() => {
    const values = grid
      .flat()
      .filter((c): c is HeatCellData => c !== null)
      .map((c) => c.value)
      .filter((v): v is number => v !== null);
    return {
      min: values.length > 0 ? Math.min(...values) : 0,
      max: values.length > 0 ? Math.max(...values) : 0,
      hasAny: grid.flat().some((c) => c !== null),
    };
  }, [grid]);

  if (props.rows.length === 0 || props.cols.length === 0 || !hasAny) {
    return <div className="chart-empty">{props.emptyText ?? "No data"}</div>;
  }

  const normalize = (v: number): number => (max === min ? 0.5 : (v - min) / (max - min));

  return (
    <table className="heat">
      <thead>
        <tr>
          {/* v7.6 §C2: row-header column sticks on horizontal scroll; the
              corner cell sits one z-level above the row headers. */}
          <th className="heat-corner" />
          {props.cols.map((col) => (
            <th key={col.key}>{col.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((row, ri) => (
          <tr key={row.key}>
            <th className="heat-rowhead">{row.label}</th>
            {props.cols.map((col, ci) => {
              const data = grid[ri][ci];
              if (data === null) {
                return (
                  <td className="heat-cell empty" key={col.key}>
                    —
                  </td>
                );
              }
              const style =
                data.value !== null ? { background: colorFor(normalize(data.value)) } : undefined;
              const content =
                data.tip !== undefined ? (
                  <Tooltip wide text={data.tip}>
                    <span>{data.display}</span>
                  </Tooltip>
                ) : (
                  data.display
                );
              return (
                <td className="heat-cell" style={style} key={col.key}>
                  {content}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
