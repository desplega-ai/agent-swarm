/**
 * Pure `CardGrid` helpers, kept free of React and `@/` imports so they stay
 * unit-testable under `bun test`. `safeHttpUrl` is shared with Table's
 * `link` kind.
 */
import { jsonPreview, truncateText } from "./json-preview";

/** Cards rendered per "Show more" step. */
export const CARD_GRID_PAGE_SIZE = 200;

/** Longest card title; past it the title ends in `…`. */
export const CARD_TITLE_MAX_CHARS = 500;

/** Only absolute http(s) URLs pass — never `javascript:`, `data:` or relative paths. */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** React key of one card: the position plus the row id, so duplicate or missing ids never collide. */
export function cardGridRowKey(row: Record<string, unknown>, index: number): string {
  return `${index}:${String(row.id ?? "")}`;
}

/** Card title text: `—` when empty, a JSON preview for objects/arrays, capped at `CARD_TITLE_MAX_CHARS`. */
export function cardGridTitleText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return jsonPreview(value);
  return truncateText(String(value), CARD_TITLE_MAX_CHARS);
}

/** A meta field's render kind: an object/array without a declared kind renders as a bounded `json` preview. */
export function cardGridFieldKind<K extends string>(
  kind: K | undefined,
  value: unknown,
): K | "json" | undefined {
  if (kind) return kind;
  return typeof value === "object" && value !== null ? "json" : undefined;
}

/** Card meta text and badge values: capped at `CARD_TITLE_MAX_CHARS` like the title. */
export function cardGridCapText(text: string): string {
  return truncateText(text, CARD_TITLE_MAX_CHARS);
}

/** The first `limit` rows plus how many are still hidden behind "Show more". */
export function cardGridVisibleRows<T>(
  rows: readonly T[],
  limit: number,
): { visible: T[]; remaining: number } {
  return { visible: rows.slice(0, limit), remaining: Math.max(0, rows.length - limit) };
}
