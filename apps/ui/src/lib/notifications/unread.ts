/**
 * The bell badge count: unread static notifications (per swarm user) plus
 * unread Comb mentions (per agent-fs identity). `mentionsUnread` is null when
 * no mentions source is active (Comb off, not connected, or an agent-fs
 * without `comment-mentions`).
 */
export function totalUnread({
  staticUnread,
  mentionsUnread,
}: {
  staticUnread: number;
  mentionsUnread: number | null;
}): number {
  return staticUnread + (mentionsUnread ?? 0);
}

/** The badge text. The badge is a 16px circle, so it caps at "9+". */
export function unreadBadgeLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}
