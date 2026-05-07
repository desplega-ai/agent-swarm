import { getDb } from "../be/db";
import { getOAuthApp } from "../be/db-queries/oauth";
import type { NotionOAuthAppMetadata } from "./types";

/**
 * Read the typed metadata blob for the `notion` provider. Falls back to an
 * empty object on missing row or unparseable JSON — keys are all optional.
 */
export function getNotionMetadata(): NotionOAuthAppMetadata {
  const app = getOAuthApp("notion");
  if (!app) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(app.metadata || "{}");
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object") return {};

  const meta = parsed as Record<string, unknown>;
  const out: NotionOAuthAppMetadata = {};

  if (typeof meta.botId === "string") out.botId = meta.botId;
  if (typeof meta.workspaceId === "string") out.workspaceId = meta.workspaceId;
  if (typeof meta.workspaceName === "string" || meta.workspaceName === null) {
    out.workspaceName = meta.workspaceName as string | null;
  }
  if (typeof meta.workspaceIcon === "string" || meta.workspaceIcon === null) {
    out.workspaceIcon = meta.workspaceIcon as string | null;
  }
  if (meta.owner && typeof meta.owner === "object") {
    out.owner = meta.owner as Record<string, unknown>;
  }
  if (typeof meta.duplicatedTemplateId === "string" || meta.duplicatedTemplateId === null) {
    out.duplicatedTemplateId = meta.duplicatedTemplateId as string | null;
  }

  return out;
}

/**
 * Read-modify-write merge of the Notion `oauth_apps.metadata` blob.
 * Wrapped in a single SQLite transaction so concurrent writers can't stomp
 * each other's keys.
 *
 * Throws if the `notion` provider row doesn't exist (caller must run
 * `initNotion()` before any metadata writes).
 */
export function updateNotionMetadata(partial: Partial<NotionOAuthAppMetadata>): void {
  const db = getDb();
  const txn = db.transaction(() => {
    const row = db.query("SELECT metadata FROM oauth_apps WHERE provider = 'notion'").get() as {
      metadata: string | null;
    } | null;

    if (!row) {
      throw new Error(
        "[notion.metadata] oauth_apps row missing for provider='notion' — call initNotion() first",
      );
    }

    let current: NotionOAuthAppMetadata = {};
    try {
      const parsed = JSON.parse(row.metadata || "{}");
      if (parsed && typeof parsed === "object") {
        current = parsed as NotionOAuthAppMetadata;
      }
    } catch {
      // Fall through with empty object
    }

    const merged: NotionOAuthAppMetadata = { ...current };

    if (partial.botId !== undefined) merged.botId = partial.botId;
    if (partial.workspaceId !== undefined) merged.workspaceId = partial.workspaceId;
    if (partial.workspaceName !== undefined) merged.workspaceName = partial.workspaceName;
    if (partial.workspaceIcon !== undefined) merged.workspaceIcon = partial.workspaceIcon;
    if (partial.owner !== undefined) merged.owner = partial.owner;
    if (partial.duplicatedTemplateId !== undefined) {
      merged.duplicatedTemplateId = partial.duplicatedTemplateId;
    }

    db.query(
      "UPDATE oauth_apps SET metadata = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE provider = 'notion'",
    ).run(JSON.stringify(merged));
  });

  txn();
}

/** Reset the metadata blob to `{}`. Used by the disconnect flow. */
export function clearNotionMetadata(): void {
  getDb()
    .query(
      "UPDATE oauth_apps SET metadata = '{}', updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE provider = 'notion'",
    )
    .run();
}
