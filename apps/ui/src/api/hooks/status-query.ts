import type { QueryClient } from "@tanstack/react-query";
import type { StatusResponse } from "../types";

export const STATUS_QUERY_KEY = ["status"] as const;

export function invalidateStatusQuery(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
}

/** Config keys `/status` reports under `identity`, which the app shell renders. */
const IDENTITY_FIELDS = {
  SWARM_ORG_NAME: "name",
  SWARM_ORG_LOGO_URL: "logo_url",
  SWARM_BRAND_COLOR: "brand_color",
} as const;

/** Keys that change `identity` on the server: the website can fill the logo. */
const IDENTITY_KEYS = new Set<string>([...Object.keys(IDENTITY_FIELDS), "SWARM_ORG_WEBSITE"]);

/**
 * The API applies a global write to its env about 250 ms after the last one,
 * so `/status` only reports it after that. Refetch once it has settled.
 */
export const IDENTITY_SETTLE_MS = 750;

let identityRefreshTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * After an identity key is saved (`value`) or removed (`null`), update the
 * shell now: write a saved value straight into the cached `/status` identity,
 * then refetch once the server has applied it. A removed value falls back to
 * the deployment env, which only the server knows, so it only refetches.
 */
export function applySavedIdentity(
  queryClient: QueryClient,
  key: string,
  value: string | null,
): void {
  if (!IDENTITY_KEYS.has(key)) return;
  const field = IDENTITY_FIELDS[key as keyof typeof IDENTITY_FIELDS];
  if (field && value !== null) {
    // An in-flight poll started before the save would land the old identity.
    void queryClient.cancelQueries({ queryKey: STATUS_QUERY_KEY });
    const trimmed = value.trim();
    queryClient.setQueryData<StatusResponse | null>(STATUS_QUERY_KEY, (current) =>
      current
        ? {
            ...current,
            identity: {
              ...current.identity,
              [field]: trimmed || (field === "name" ? "Swarm" : null),
            },
          }
        : current,
    );
  }
  clearTimeout(identityRefreshTimer);
  identityRefreshTimer = setTimeout(() => {
    void invalidateStatusQuery(queryClient);
  }, IDENTITY_SETTLE_MS);
}
