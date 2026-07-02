import { getDb } from "../be/db";
import { getOAuthApp } from "../be/db-queries/oauth";
import type { JiraOAuthAppMetadata } from "./types";

/**
 * Read the typed metadata blob for the `jira` provider.
 *
 * Falls back to an empty object if the provider row doesn't exist or the
 * metadata column is unparseable JSON. We never throw on shape coercion —
 * the keys are all optional and downstream callers already null-check.
 */
export function getJiraMetadata(): JiraOAuthAppMetadata {
  const app = getOAuthApp("jira");
  if (!app) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(app.metadata || "{}");
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object") return {};

  const meta = parsed as Record<string, unknown>;
  const out: JiraOAuthAppMetadata = {};

  if (typeof meta.cloudId === "string") out.cloudId = meta.cloudId;
  if (typeof meta.siteUrl === "string") out.siteUrl = meta.siteUrl;
  if (Array.isArray(meta.webhookIds)) {
    out.webhookIds = meta.webhookIds.filter(
      (entry): entry is { id: number; expiresAt: string; jql: string } =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as { id?: unknown }).id === "number" &&
        typeof (entry as { expiresAt?: unknown }).expiresAt === "string" &&
        typeof (entry as { jql?: unknown }).jql === "string",
    );
  }

  return out;
}

/**
 * Read-modify-write merge of the Jira `oauth_apps.metadata` blob.
 *
 * Wrapped in a single SQLite transaction so concurrent writers can't stomp
 * each other's keys (e.g. Phase 2 cloudId write + Phase 5 webhookIds write).
 *
 * Merge semantics:
 *   - Scalar keys (`cloudId`, `siteUrl`): shallow merge — partial overwrites
 *     existing value if defined.
 *   - `webhookIds`: id-keyed merge — entries in `partial.webhookIds` replace
 *     existing entries with the same `id`, untouched ids are preserved.
 *
 * Throws if the `jira` provider row doesn't exist (caller must run `initJira()`
 * before any metadata writes).
 */
export function updateJiraMetadata(partial: Partial<JiraOAuthAppMetadata>): void {
  const db = getDb();
  const txn = db.transaction(() => {
    const row = db.query("SELECT metadata FROM oauth_apps WHERE provider = 'jira'").get() as {
      metadata: string | null;
    } | null;

    if (!row) {
      throw new Error(
        "[jira.metadata] oauth_apps row missing for provider='jira' — call initJira() first",
      );
    }

    let current: JiraOAuthAppMetadata = {};
    try {
      const parsed = JSON.parse(row.metadata || "{}");
      if (parsed && typeof parsed === "object") {
        current = parsed as JiraOAuthAppMetadata;
      }
    } catch {
      // Fall through with empty object
    }

    const merged: JiraOAuthAppMetadata = { ...current };

    if (partial.cloudId !== undefined) merged.cloudId = partial.cloudId;
    if (partial.siteUrl !== undefined) merged.siteUrl = partial.siteUrl;

    if (partial.webhookIds !== undefined) {
      const byId = new Map<number, { id: number; expiresAt: string; jql: string }>();
      for (const existing of current.webhookIds ?? []) {
        byId.set(existing.id, existing);
      }
      for (const incoming of partial.webhookIds) {
        byId.set(incoming.id, incoming);
      }
      merged.webhookIds = [...byId.values()];
    }

    db.query(
      "UPDATE oauth_apps SET metadata = ?, updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE provider = 'jira'",
    ).run(JSON.stringify(merged));
  });

  txn();
}

/**
 * Reset the Jira `oauth_apps.metadata` blob to `{}`. Used by the disconnect
 * flow to drop cloudId, siteUrl, and webhookIds in one shot. The row itself
 * stays — `initJira()` requires the `oauth_apps` row to exist.
 */
export function clearJiraMetadata(): void {
  getDb()
    .query(
      "UPDATE oauth_apps SET metadata = '{}', updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE provider = 'jira'",
    )
    .run();
}
