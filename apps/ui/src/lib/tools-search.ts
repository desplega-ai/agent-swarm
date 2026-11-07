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

/** One titled group of tool cards on the Tools tab. */
export interface ToolGroup {
  title: string;
  tools: IntegrationDef[];
}

/**
 * The Tools tab groups with the cards that match `search` (every card when it
 * is empty). A group with no match is dropped.
 */
export function filterToolGroups(groups: ToolGroup[], search: string): ToolGroup[] {
  const q = search.trim();
  return groups
    .map((group) => ({
      title: group.title,
      tools: q ? group.tools.filter((def) => matchTool(def, q)) : group.tools,
    }))
    .filter((group) => group.tools.length > 0);
}
