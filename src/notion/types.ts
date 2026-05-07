/**
 * Narrow types for the Notion read-only KB integration. Intentionally NOT a
 * mirror of Notion's full API graph — we expose only fields the swarm's MCP
 * tool surface returns, so accidental scope creep stays a deliberate edit.
 */

export interface NotionOAuthAppMetadata {
  /** Notion bot id from the OAuth code-exchange response. */
  botId?: string;
  /** Workspace UUID. */
  workspaceId?: string;
  /** Workspace display name (nullable per Notion). */
  workspaceName?: string | null;
  /** Workspace icon URL (nullable per Notion). */
  workspaceIcon?: string | null;
  /** Owner descriptor — `{ type: "user" | "workspace", ... }`. */
  owner?: Record<string, unknown>;
  /** Set when the user duplicated a template during install. */
  duplicatedTemplateId?: string | null;
}

/** Common shape returned by /v1/search hits and database query rows. */
export interface NotionPageSummary {
  id: string;
  /** Resolved page title (joined plain_text from the `title` property). */
  title: string;
  type: "page" | "database" | "unknown";
  url: string | null;
  lastEditedTime: string | null;
  createdTime: string | null;
  parent: { type: string; id?: string } | null;
}

export interface NotionDatabaseSummary {
  id: string;
  title: string;
  description: string | null;
  url: string | null;
  lastEditedTime: string | null;
  /** Map of property name → property type. Schema preview, not full definitions. */
  properties: Record<string, string>;
}

export interface NotionPageDetail extends NotionPageSummary {
  properties: Record<string, NotionPropertySummary>;
  /** Plaintext rendering of the page's block tree (when includeContent=true). */
  content?: string;
  /** Capped block count actually walked (may be less than the page's true size). */
  blocksWalked?: number;
}

export interface NotionPropertySummary {
  type: string;
  /** Stringified value for fast agent inspection. Use the raw API for structured access. */
  preview: string;
}

/** Surfaced when a Notion API call returns 429. */
export interface NotionRateLimitError {
  kind: "rate_limited";
  retryAfterSeconds: number | null;
  message: string;
}

/** Surfaced when a Notion API call returns 4xx/5xx that isn't 401 (handled internally). */
export interface NotionApiError {
  kind: "api_error";
  status: number;
  code: string | null;
  message: string;
}
