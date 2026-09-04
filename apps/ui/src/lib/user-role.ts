import type { User } from "@/api/types";

/** Missing roles are onboarding users and inherit admin-level UI prompts. */
export function isAdminLike(user: Pick<User, "role"> | null): boolean {
  if (!user) return false;
  const role = user.role?.trim();
  return !role || role === "admin";
}
