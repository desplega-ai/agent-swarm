/**
 * The Pareto frontier of `items`, where lower x and higher y are better: the
 * items no other item beats on both axes, left to right. Of two items with the
 * same x only the higher y can be on it, and a tie on both axes keeps the first.
 */
export function paretoFrontier<T>(
  items: readonly T[],
  x: (item: T) => number,
  y: (item: T) => number,
): T[] {
  const sorted = items
    .filter((t) => Number.isFinite(x(t)) && Number.isFinite(y(t)))
    .sort((a, b) => x(a) - x(b) || y(b) - y(a));
  const out: T[] = [];
  let best = Number.NEGATIVE_INFINITY;
  for (const t of sorted) {
    if (y(t) > best) {
      out.push(t);
      best = y(t);
    }
  }
  return out;
}
