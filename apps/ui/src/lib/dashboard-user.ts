// Relative imports, and no `@/lib/config`: the API client imports this
// module, and the root `bun test` run resolves no `@/` alias it has not mocked.
import { deriveStorageKey } from "../hooks/use-dismissible-card-key";
import { uiDeploymentConfig } from "./deployment-config";

/** Per-connection localStorage card key for the dashboard identity pick. */
export const CURRENT_USER_CARD_KEY = "current-user";

/** Request header naming the dashboard's picked user (see src/http/favorite-owner.ts). */
export const DASHBOARD_USER_HEADER = "X-Swarm-User-Id";

/**
 * The user this dashboard tab acts as, for a tab on the shared operator key.
 * A deployment user (VITE_USER_ID) wins over the picker. A user-bound token
 * returns null: the server already knows that user.
 *
 * Read straight from storage, not from React state, so the first requests of
 * a page load already carry it and per-user data (favorites) never flashes
 * the shared operator set.
 */
export function dashboardUserIdFor(config: { apiUrl: string; apiKey: string }): string | null {
  // A user-bound `aswt_` token (see `isUserTokenApiKey` in lib/config).
  if (config.apiKey.startsWith("aswt_")) return null;
  if (uiDeploymentConfig.userId) return uiDeploymentConfig.userId;
  try {
    const stored = localStorage.getItem(deriveStorageKey(config.apiUrl, CURRENT_USER_CARD_KEY));
    return stored && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}
