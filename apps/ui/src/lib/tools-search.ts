// Client-side search for the Connect › Tools tabs. Each tab filters its own
// rows with the `?search` value, so the tab row holds one search field.

import type { McpServer, OAuthAppSummary, ScriptConnection } from "../api/types";
import type { IntegrationDef } from "./integrations-catalog";

/** True when the joined fields contain every word of `search` (case-insensitive). */
export function matchesWords(
  fields: ReadonlyArray<string | null | undefined>,
  search: string,
): boolean {
  const text = fields.filter(Boolean).join(" ").toLowerCase();
  return search
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

export function matchTool(def: IntegrationDef, search: string): boolean {
  return matchesWords([def.name, def.id, def.description], search);
}

export function matchScriptConnection(connection: ScriptConnection, search: string): boolean {
  return matchesWords(
    [
      connection.slug,
      connection.displayName,
      connection.kind,
      connection.baseUrl,
      connection.mcpServerId,
    ],
    search,
  );
}

export function matchOAuthApp(app: OAuthAppSummary, search: string): boolean {
  return matchesWords(
    [
      app.provider,
      app.clientId,
      app.source,
      ...app.authorizations.flatMap((auth) => [auth.label, auth.accountEmail]),
    ],
    search,
  );
}

export function matchMcpServer(server: McpServer, search: string): boolean {
  return matchesWords(
    [server.name, server.description, server.transport, server.scope, server.url, server.command],
    search,
  );
}

/**
 * Split the Tools tab cards into the grid and the "Show N more" row. The grid
 * holds `primary` (in order) and every `more` card that is in use. The rest
 * waits behind "Show N more". A search shows every match in the grid.
 */
export function layoutToolCards(
  primary: IntegrationDef[],
  more: IntegrationDef[],
  inUse: (def: IntegrationDef) => boolean,
  search: string,
): { shown: IntegrationDef[]; hidden: IntegrationDef[] } {
  if (search.trim()) {
    return { shown: [...primary, ...more].filter((def) => matchTool(def, search)), hidden: [] };
  }
  return {
    shown: [...primary, ...more.filter(inUse)],
    hidden: more.filter((def) => !inUse(def)),
  };
}
