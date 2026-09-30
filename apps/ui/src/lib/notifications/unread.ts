/** The badge text. The badge is a 16px circle, so it caps at "9+". */
export function unreadBadgeLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}
