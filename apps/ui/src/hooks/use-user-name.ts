import { useCallback, useMemo } from "react";
import { useUsers } from "@/api/hooks/use-users";

/**
 * Resolve a stored user reference (user id, primary email or alias) to the
 * person's display name. Returns `undefined` when the directory has no match
 * or is not readable by this token, so callers can fall back to the raw value.
 */
export function useUserName(): (idOrEmail: string) => string | undefined {
  const { data: users } = useUsers();
  const index = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of users ?? []) {
      map.set(u.id, u.name);
      if (u.email) map.set(u.email.toLowerCase(), u.name);
      for (const alias of u.emailAliases ?? []) map.set(alias.toLowerCase(), u.name);
    }
    return map;
  }, [users]);
  return useCallback(
    (idOrEmail: string) => index.get(idOrEmail) ?? index.get(idOrEmail.toLowerCase()),
    [index],
  );
}
