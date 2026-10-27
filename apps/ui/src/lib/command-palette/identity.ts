// Relative imports: the root `bun test` run resolves no `@/` alias.
import { dashboardUserIdFor } from "../dashboard-user";

/** The connection the palette searches through. */
export interface PaletteConnection {
  apiUrl: string;
  apiKey: string;
}

/**
 * Who the palette searches as: the swarm, the key's last four characters (the
 * non-sensitive preview the server stores as `tokenPreview`) and the picked
 * dashboard user. Search results and recents are keyed by it, so one person's
 * private tasks never answer for another on the same swarm and browser.
 */
export function paletteIdentity(connection: PaletteConnection): string {
  const user = dashboardUserIdFor(connection) ?? "";
  return [connection.apiUrl, connection.apiKey.slice(-4), user].join("|");
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
