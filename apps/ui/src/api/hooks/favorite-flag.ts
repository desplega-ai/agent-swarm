type Row = { id?: unknown; favorite?: unknown };

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patchRow<T>(row: T, itemId: string, favorite: boolean): T {
  return isRow(row) && row.id === itemId ? { ...row, favorite } : row;
}

function patchRows(rows: unknown[], itemId: string, favorite: boolean): unknown[] {
  return rows.some((row) => isRow(row) && row.id === itemId)
    ? rows.map((row) => patchRow(row, itemId, favorite))
    : rows;
}

/**
 * Set `favorite` on the entity `itemId` inside cached query data, for the
 * optimistic star flip. Handles the three cache shapes that carry the flag:
 * a detail object, a bare row array, and a list envelope such as
 * `{ workflows: [...] }`. Anything else comes back unchanged (same reference).
 */
export function patchFavoriteFlag<T>(data: T, itemId: string, favorite: boolean): T {
  if (Array.isArray(data)) return patchRows(data, itemId, favorite) as T;
  if (!isRow(data)) return data;
  if (data.id === itemId) return { ...data, favorite };

  let changed = false;
  const next: Record<string, unknown> = { ...data };
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(value)) continue;
    const patched = patchRows(value, itemId, favorite);
    if (patched !== value) {
      next[key] = patched;
      changed = true;
    }
  }
  return changed ? (next as T) : data;
}
