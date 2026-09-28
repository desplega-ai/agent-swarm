import { useCallback, useMemo } from "react";
import { useUsers } from "@/api/hooks/use-users";
import type { User } from "@/api/types";

/**
 * Resolve a stored user reference (user id, primary email or alias) to the
 * person's directory entry. Returns `undefined` when the directory has no
 * match or is not readable by this token, so callers can fall back to the raw
 * value.
 */
export function useUserLookup(): (idOrEmail: string) => User | undefined {
  const { data: users } = useUsers();
  const index = useMemo(() => {
    const map = new Map<string, User>();
    for (const u of users ?? []) {
      map.set(u.id, u);
      if (u.email) map.set(u.email.toLowerCase(), u);
      for (const alias of u.emailAliases ?? []) map.set(alias.toLowerCase(), u);
    }
    return map;
  }, [users]);
  return useCallback(
    (idOrEmail: string) => index.get(idOrEmail) ?? index.get(idOrEmail.toLowerCase()),
    [index],
  );
}

/** The display name for a stored user reference; see `useUserLookup`. */
export function useUserName(): (idOrEmail: string) => string | undefined {
  const lookup = useUserLookup();
  return useCallback((idOrEmail: string) => lookup(idOrEmail)?.name, [lookup]);
}
