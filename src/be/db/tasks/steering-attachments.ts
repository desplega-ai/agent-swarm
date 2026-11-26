import { type SteeringAttachment, SteeringAttachmentsSchema } from "../../../types";

/**
 * The stored JSON snapshot of a steering message's files (migration 394).
 * NULL, an empty list or unreadable JSON reads as none.
 */
export function parseSteeringAttachments(
  raw: string | null | undefined,
): SteeringAttachment[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = SteeringAttachmentsSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.length > 0 ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
