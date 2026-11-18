import { type UserAvatar, UserAvatarSchema } from "../../../types";

/** Malformed avatar JSON reads as "no avatar", like `parseAgentAvatar`. */
export function parseUserAvatar(raw: string | null): UserAvatar | null {
  if (!raw) return null;
  try {
    const parsed = UserAvatarSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
