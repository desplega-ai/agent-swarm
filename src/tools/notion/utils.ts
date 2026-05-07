import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getOAuthTokens } from "@/be/db-queries/oauth";
import { NotionApiError, NotionNotConnectedError, NotionRateLimitedError } from "@/notion/client";
import type {
  NotionDatabaseSummary,
  NotionPageSummary,
  NotionPropertySummary,
} from "@/notion/types";

/**
 * Build a structured "not connected" tool result. Surfaced when the agent
 * tries to use a Notion tool without OAuth completed. Tells the agent
 * exactly where to point the user.
 */
export function notConnectedResult(): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "Notion is not connected. Run OAuth at <MCP_BASE_URL>/api/trackers/notion/authorize to connect, then retry this tool.",
      },
    ],
    structuredContent: {
      success: false,
      reason: "not_connected",
      howToFix:
        "Visit <MCP_BASE_URL>/api/trackers/notion/authorize to complete OAuth (replace <MCP_BASE_URL> with your swarm API host).",
    },
  };
}

/**
 * Translate a thrown error from `notionFetch` into a structured tool result.
 * Each error class maps to a distinct `reason` so agents can branch on it.
 */
export function notionErrorToResult(err: unknown): CallToolResult {
  if (err instanceof NotionNotConnectedError) {
    return notConnectedResult();
  }
  if (err instanceof NotionRateLimitedError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Notion rate-limited. Retry-After: ${err.retryAfterSeconds ?? "unknown"} seconds.`,
        },
      ],
      structuredContent: {
        success: false,
        reason: "rate_limited",
        retryAfterSeconds: err.retryAfterSeconds,
        message: err.message,
      },
    };
  }
  if (err instanceof NotionApiError) {
    return {
      isError: true,
      content: [{ type: "text", text: `Notion API error (${err.status}): ${err.message}` }],
      structuredContent: {
        success: false,
        reason: "api_error",
        status: err.status,
        code: err.code,
        message: err.message,
      },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: `Notion call failed: ${message}` }],
    structuredContent: { success: false, reason: "unknown_error", message },
  };
}

/** Returns true iff a Notion access token exists in `oauth_tokens`. */
export function hasNotionToken(): boolean {
  return !!getOAuthTokens("notion");
}

// ─── Response shaping ────────────────────────────────────────────────────────

interface NotionRichTextSegment {
  plain_text?: string;
  text?: { content?: string };
}

interface NotionPropertyValue {
  type?: string;
  title?: NotionRichTextSegment[];
  rich_text?: NotionRichTextSegment[];
  number?: number | null;
  select?: { name?: string } | null;
  multi_select?: Array<{ name?: string }>;
  status?: { name?: string } | null;
  date?: { start?: string; end?: string | null } | null;
  checkbox?: boolean;
  url?: string | null;
  email?: string | null;
  phone_number?: string | null;
  formula?: {
    type?: string;
    string?: string;
    number?: number;
    boolean?: boolean;
    date?: { start?: string };
  };
  relation?: Array<{ id?: string }>;
  // Many other variants exist — fall through to JSON.stringify for unknowns.
}

interface NotionPageObject {
  id: string;
  object?: string;
  url?: string | null;
  last_edited_time?: string;
  created_time?: string;
  parent?: { type?: string; database_id?: string; page_id?: string; workspace?: boolean };
  properties?: Record<string, NotionPropertyValue>;
}

interface NotionDatabaseObject {
  id: string;
  object?: string;
  url?: string | null;
  last_edited_time?: string;
  title?: NotionRichTextSegment[];
  description?: NotionRichTextSegment[];
  properties?: Record<string, { type?: string } & Record<string, unknown>>;
  /** Present on database objects under Notion API version 2025-09-03+. */
  data_sources?: Array<{ id?: string; name?: string | null }>;
}

function joinRichText(segments?: NotionRichTextSegment[]): string {
  if (!segments || segments.length === 0) return "";
  return segments
    .map((s) => s.plain_text ?? s.text?.content ?? "")
    .filter(Boolean)
    .join("");
}

function pickPageTitle(page: NotionPageObject): string {
  const props = page.properties ?? {};
  for (const value of Object.values(props)) {
    if (value && value.type === "title" && Array.isArray(value.title)) {
      const t = joinRichText(value.title);
      if (t) return t;
    }
  }
  return "(untitled)";
}

export function shapePageSummary(obj: unknown): NotionPageSummary {
  const page = obj as NotionPageObject;
  const objectType =
    page.object === "database" ? "database" : page.object === "page" ? "page" : "unknown";
  return {
    id: page.id,
    title:
      objectType === "database"
        ? joinRichText((obj as NotionDatabaseObject).title) || "(untitled)"
        : pickPageTitle(page),
    type: objectType,
    url: page.url ?? null,
    lastEditedTime: page.last_edited_time ?? null,
    createdTime: page.created_time ?? null,
    parent: page.parent
      ? {
          type: page.parent.type ?? "unknown",
          id: page.parent.database_id ?? page.parent.page_id,
        }
      : null,
  };
}

export function shapeDatabaseSummary(obj: unknown): NotionDatabaseSummary {
  const db = obj as NotionDatabaseObject;
  const propertiesSummary: Record<string, string> = {};
  if (db.properties && typeof db.properties === "object") {
    for (const [name, prop] of Object.entries(db.properties)) {
      const propType = (prop as { type?: string } | undefined)?.type;
      if (typeof propType === "string") propertiesSummary[name] = propType;
    }
  }
  const dataSources = Array.isArray(db.data_sources)
    ? db.data_sources
        .map((ds) => ({ id: ds.id ?? "", name: ds.name ?? "" }))
        .filter((ds) => ds.id.length > 0)
    : [];
  return {
    id: db.id,
    title: joinRichText(db.title) || "(untitled)",
    description: joinRichText(db.description) || null,
    url: db.url ?? null,
    lastEditedTime: db.last_edited_time ?? null,
    properties: propertiesSummary,
    dataSources,
  };
}

export function shapeProperty(value: NotionPropertyValue): NotionPropertySummary {
  const type = value.type ?? "unknown";
  let preview: string;
  switch (type) {
    case "title":
      preview = joinRichText(value.title);
      break;
    case "rich_text":
      preview = joinRichText(value.rich_text);
      break;
    case "number":
      preview = value.number == null ? "" : String(value.number);
      break;
    case "select":
      preview = value.select?.name ?? "";
      break;
    case "multi_select":
      preview = (value.multi_select ?? [])
        .map((s) => s.name)
        .filter(Boolean)
        .join(", ");
      break;
    case "status":
      preview = value.status?.name ?? "";
      break;
    case "date":
      preview = value.date?.start
        ? value.date.end
          ? `${value.date.start}..${value.date.end}`
          : value.date.start
        : "";
      break;
    case "checkbox":
      preview = value.checkbox ? "true" : "false";
      break;
    case "url":
      preview = value.url ?? "";
      break;
    case "email":
      preview = value.email ?? "";
      break;
    case "phone_number":
      preview = value.phone_number ?? "";
      break;
    case "formula": {
      const f = value.formula ?? {};
      preview =
        f.string ??
        (f.number != null
          ? String(f.number)
          : f.boolean != null
            ? String(f.boolean)
            : (f.date?.start ?? ""));
      break;
    }
    case "relation":
      preview = (value.relation ?? [])
        .map((r) => r.id)
        .filter(Boolean)
        .join(",");
      break;
    default:
      try {
        preview = JSON.stringify(value);
      } catch {
        preview = "";
      }
  }
  return { type, preview };
}

export function shapePageProperties(page: NotionPageObject): Record<string, NotionPropertySummary> {
  const out: Record<string, NotionPropertySummary> = {};
  const props = page.properties ?? {};
  for (const [name, value] of Object.entries(props)) {
    out[name] = shapeProperty(value);
  }
  return out;
}
