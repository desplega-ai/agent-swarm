// Relative imports: the root `bun test` run resolves no `@/` alias.
import { dashboardUserIdFor } from "../dashboard-user";
import { sha256Hex } from "../sha256";

/** The connection the palette searches through. */
export interface PaletteConnection {
  apiUrl: string;
  apiKey: string;
}

/**
 * Who the palette searches as: the swarm, a credential id and the picked
 * dashboard user. Search results and recents are keyed by it, so one person's
 * private tasks never answer for another on the same swarm and browser.
 *
 * The credential id is the first 128 bits of the key's SHA-256: one-way, so
 * the raw key never reaches a query key or a storage key name, and collision
 * resistant, because a user-bound token carries no dashboard user and only
 * the key tells two of them apart.
 */
export function paletteIdentity(connection: PaletteConnection): string {
  const user = dashboardUserIdFor(connection) ?? "";
  return [connection.apiUrl, credentialId(connection.apiKey), user].join("|");
}

function credentialId(apiKey: string): string {
  return sha256Hex(apiKey).slice(0, 32);
}

/** First query-key segment of every palette search; never persisted. */
export const PALETTE_QUERY_ROOT = "command-palette";

/** The react-query key of one provider's search. */
export function paletteSearchKey(
  connection: PaletteConnection,
  providerId: string,
  query: string,
  limit: number,
) {
  return [PALETTE_QUERY_ROOT, paletteIdentity(connection), providerId, query, limit] as const;
}

/**
 * `keepPreviousData` within one identity. The palette keeps the last answer
 * on screen while the next keystroke loads, but never across a user or swarm
 * switch: the previous identity's results could name their private tasks.
 */
export function keepPreviousWithin(identity: string) {
  return <T>(
    previous: T | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ): T | undefined => (previousQuery?.queryKey[1] === identity ? previous : undefined);
}
