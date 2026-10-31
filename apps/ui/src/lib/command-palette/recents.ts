/**
 * The palette's recent picks, shown when the search is empty. Browser-local
 * and keyed by `paletteIdentity`: the dashboard can switch swarms and users,
 * and a recent pick can name one person's private task.
 */
import { type PaletteConnection, paletteIdentity } from "./identity";

export interface RecentItem {
  /** `nav` or a search provider id: picks the icon. */
  kind: string;
  title: string;
  href: string;
  detail?: string;
}

const MAX_RECENTS = 6;

function storageKey(connection: PaletteConnection): string {
  return `agent-swarm:cmdk-recents:${paletteIdentity(connection)}`;
}

function isRecent(value: unknown): value is RecentItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.kind === "string" && typeof item.title === "string" && typeof item.href === "string"
  );
}

export function readRecents(connection: PaletteConnection): RecentItem[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(connection)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

/** Moves `item` to the front (one entry per href) and returns the new list. */
export function pushRecent(connection: PaletteConnection, item: RecentItem): RecentItem[] {
  const next = [item, ...readRecents(connection).filter((r) => r.href !== item.href)].slice(
    0,
    MAX_RECENTS,
  );
  try {
    localStorage.setItem(storageKey(connection), JSON.stringify(next));
  } catch {
    // Storage full or blocked: recents are a convenience.
  }
  return next;
}
