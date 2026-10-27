/**
 * The palette's recent picks, shown when the search is empty. Browser-local
 * and keyed per connection: the dashboard can switch swarms, and a task id
 * from one swarm means nothing on another.
 */

export interface RecentItem {
  /** `nav` or a search provider id: picks the icon. */
  kind: string;
  title: string;
  href: string;
  detail?: string;
}

const MAX_RECENTS = 6;

function storageKey(apiUrl: string): string {
  return `agent-swarm:cmdk-recents:${apiUrl}`;
}

function isRecent(value: unknown): value is RecentItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.kind === "string" && typeof item.title === "string" && typeof item.href === "string"
  );
}

export function readRecents(apiUrl: string): RecentItem[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(apiUrl)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isRecent).slice(0, MAX_RECENTS) : [];
  } catch {
    return [];
  }
}

/** Moves `item` to the front (one entry per href) and returns the new list. */
export function pushRecent(apiUrl: string, item: RecentItem): RecentItem[] {
  const next = [item, ...readRecents(apiUrl).filter((r) => r.href !== item.href)].slice(
    0,
    MAX_RECENTS,
  );
  try {
    localStorage.setItem(storageKey(apiUrl), JSON.stringify(next));
  } catch {
    // Storage full or blocked: recents are a convenience.
  }
  return next;
}
