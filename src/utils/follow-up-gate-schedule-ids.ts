const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Split `FOLLOW_UP_GATE_SCHEDULE_IDS`, a comma-separated id list. Blank entries are dropped. */
export function parseFollowUpGateScheduleIds(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function isFollowUpGateScheduleId(id: string): boolean {
  return UUID_RE.test(id);
}
