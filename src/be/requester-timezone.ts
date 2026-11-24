import { isValidTimezone } from "../utils/deferral-time";
import { getUserById } from "./db";

/** Resolve the requester's clock at render time so profile edits apply to existing tasks. */
export async function resolveRequesterTimezone(requestedByUserId?: string, fallback?: string) {
  const user = requestedByUserId ? await getUserById(requestedByUserId) : null;
  const timezone = user?.timezone;
  if (isValidTimezone(timezone)) return { tz: timezone, isFallback: false };
  return { tz: isValidTimezone(fallback) ? fallback : "UTC", isFallback: true };
}
