/**
 * What a `NumberInput` commits to `/ui/<id>/value` for the text it holds.
 *
 * - a parseable number → that number, clamped to `min` / `max`
 * - empty or whitespace-only text → `null` (the field was cleared)
 * - anything else (a bare `-`, `abc`, `1.2.3`, `Infinity`) → `undefined`:
 *   a non-numeric in-progress edit that must leave the stored value untouched
 *   instead of clobbering it.
 */
export function parseNumberInputValue(
  raw: string,
  min?: number,
  max?: number,
): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  let clamped = parsed;
  if (typeof min === "number") clamped = Math.max(min, clamped);
  if (typeof max === "number") clamped = Math.min(max, clamped);
  return clamped;
}
