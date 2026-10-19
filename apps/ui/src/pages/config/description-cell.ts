/**
 * The cell is a flex box (ag-grid.css) and its `.ag-cell-wrapper` child defaults to
 * `min-width: auto`, so long text widened the wrapper past the column instead of
 * ellipsizing. `min-w-0` lets it shrink to the column; `text-overflow` needs `block`, not flex.
 */
export const DESCRIPTION_CELL_CLASS =
  "text-muted-foreground [&>.ag-cell-wrapper]:min-w-0 [&_.ag-cell-value]:block!";

export function formatDescription(params: { value: string | null | undefined }): string {
  return params.value || "—";
}
