import { isGroupKey } from "../assets/key";
import { healthyChatSdkAdapters } from "../integrations/chat-sdk/status";
import type { ChecklistItem } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getAutomationSetupStates, setupIntegrationFlags } from "./automation-preflight";
import { getDbClient } from "./db";
import { sessionSummaryQuery } from "./db/session-tree";
import { getOAuthTokens } from "./db-queries/oauth";

type ChecklistRow = Omit<ChecklistItem, "meta" | "signal" | "done" | "editable"> & {
  meta: string | null;
};

export type ChecklistActor = {
  id: string;
  userId: string | null;
  canEditSwarm: boolean;
};

export type ChecklistAction =
  | {
      action: "add";
      kind: ChecklistItem["kind"];
      label: string;
      href?: string;
      scope: ChecklistItem["scope"];
      meta?: Record<string, unknown>;
    }
  | { action: "remove" | "restore" | "done"; id: string; reason?: string }
  | { action: "reorder"; id: string; sortOrder: number };

export class ChecklistError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404,
  ) {
    super(message);
  }
}

async function seedChecklist(userId: string | null): Promise<void> {
  const db = getDbClient();
  await db.run(
    `INSERT OR IGNORE INTO checklist_items (id, scope, kind, label, href, sortOrder)
     VALUES ('swarm:channel', 'swarm', 'channel', 'Connect a chat channel', '/integrations/channels', 0),
            ('swarm:tool', 'swarm', 'tool', 'Connect work tools', '/integrations/tools', 1)`,
  );
  if (userId) {
    await db.run(
      `INSERT OR IGNORE INTO checklist_items
       (id, scope, userId, kind, label, href, sortOrder, created_by, updated_by)
       VALUES (?, 'user', ?, 'use_case', 'Plan your first use case', '/sessions', 2, ?, ?)`,
      [`user:${userId}:use_case`, userId, userId, userId],
    );
  }
}

async function getUseCaseSignal(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  // Apps have keys but no creator column. See .non-audit-tables.
  // Bound session checks to the user's 100 most recently created asset keys.
  const candidates = await getDbClient().query<{ key: string }>(
    `SELECT "key", MAX(createdAt) AS newest FROM (
       SELECT "key", createdAt FROM scheduled_tasks WHERE created_by = ?
       UNION ALL SELECT "key", createdAt FROM pages WHERE created_by = ?
       UNION ALL SELECT "key", createdAt FROM workflows WHERE created_by = ?
     ) GROUP BY "key" ORDER BY newest DESC, "key" LIMIT 100`,
    [userId, userId, userId],
  );
  for (const { key } of candidates) {
    if (!isGroupKey(key)) continue;
    const query = sessionSummaryQuery({ keyPrefix: key, viewer: { userId, scope: "all" } });
    const read = await getDbClient().get<{ found: number }>(
      `SELECT 1 AS found FROM (${query.sql}) WHERE readState = 'read' LIMIT 1`,
      query.params,
    );
    if (read) return true;
  }
  return false;
}

export async function listChecklist(
  userId: string | null,
  canEditSwarm = false,
): Promise<ChecklistItem[]> {
  await seedChecklist(userId);
  const setup = await getAutomationSetupStates();
  const flags = setupIntegrationFlags(setup);
  const [google, microsoft, useCase] = await Promise.all([
    getOAuthTokens("google"),
    getOAuthTokens("microsoft"),
    getUseCaseSignal(userId),
  ]);
  const adapters = new Set<string>(healthyChatSdkAdapters());
  if (flags.slack) adapters.add("slack");
  const tool =
    flags.github ||
    flags.gitlab ||
    flags.bitbucket ||
    flags.linear ||
    flags.jira ||
    google !== null ||
    microsoft !== null;
  const rows = await getDbClient().query<ChecklistRow>(
    `SELECT c.*, CASE WHEN c.statusChangedBy LIKE 'lead:%' THEN 'Lead' ELSE u.name END AS statusChangedByName
     FROM checklist_items c LEFT JOIN users u ON u.id = c.statusChangedBy
     WHERE c.scope = 'swarm' OR (c.scope = 'user' AND c.userId = ?)
     ORDER BY c.sortOrder, c.createdAt, c.id`,
    [userId],
  );
  return rows.map((row) => {
    const meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : null;
    const signal =
      row.kind === "custom"
        ? null
        : row.kind === "channel"
          ? typeof meta?.adapter === "string"
            ? adapters.has(meta.adapter)
            : adapters.size > 0
          : row.kind === "tool"
            ? tool
            : useCase;
    // Explicit fields keep audit columns internal to the service.
    return {
      id: row.id,
      scope: row.scope,
      userId: row.userId,
      kind: row.kind,
      label: row.label,
      href: row.href,
      meta,
      sortOrder: row.sortOrder,
      status: row.status,
      statusChangedAt: row.statusChangedAt,
      statusChangedBy: row.statusChangedBy,
      statusChangedByName: row.statusChangedByName,
      statusReason: row.statusReason,
      nudgedAt: row.nudgedAt,
      nudgedTaskId: row.nudgedTaskId,
      signal,
      done: row.status === "done" || signal === true,
      editable: row.scope === "swarm" ? canEditSwarm : row.userId === userId,
      createdAt: row.createdAt,
      lastUpdatedAt: row.lastUpdatedAt,
    };
  });
}

export async function mutateChecklist(
  actor: ChecklistActor,
  action: ChecklistAction,
): Promise<ChecklistItem> {
  const id = await getDbClient().transaction(async (tx) => {
    await seedChecklist(actor.userId);
    const id = action.action === "add" ? crypto.randomUUID() : action.id;
    const row =
      action.action === "add"
        ? action
        : await tx.get<ChecklistRow>("SELECT * FROM checklist_items WHERE id = ?", [id]);
    if (!row) throw new ChecklistError("Checklist item not found", 404);
    if (row.scope === "swarm" && !actor.canEditSwarm) {
      throw new ChecklistError("Swarm checklist items require config.write.any", 403);
    }
    if (row.scope === "user") {
      if (!actor.userId)
        throw new ChecklistError(
          "A user is required for user checklist items",
          action.action === "add" ? 400 : 403,
        );
      if (action.action !== "add" && "userId" in row && row.userId !== actor.userId) {
        throw new ChecklistError("This checklist item belongs to another user", 403);
      }
    }
    const now = new Date().toISOString();
    if (action.action === "add") {
      const userId = action.scope === "user" ? actor.userId : null;
      const max = await tx.get<{ sortOrder: number }>(
        "SELECT COALESCE(MAX(sortOrder), -1) + 1 AS sortOrder FROM checklist_items WHERE scope = ? AND userId IS ?",
        [action.scope, userId],
      );
      await tx.run(
        `INSERT INTO checklist_items
         (id, scope, userId, kind, label, href, meta, sortOrder, createdAt, lastUpdatedAt, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          action.scope,
          userId,
          action.kind,
          // Free text from users and the Lead: keep recognisable secrets out at rest.
          scrubSecrets(action.label),
          action.href ? scrubSecrets(action.href) : null,
          action.meta ? scrubSecrets(JSON.stringify(action.meta)) : null,
          max!.sortOrder,
          now,
          now,
          actor.id,
          actor.id,
        ],
      );
    } else if (action.action === "reorder") {
      await tx.run(
        "UPDATE checklist_items SET sortOrder = ?, lastUpdatedAt = ?, updated_by = ? WHERE id = ?",
        [action.sortOrder, now, actor.id, id],
      );
    } else {
      const status =
        action.action === "remove" ? "removed" : action.action === "done" ? "done" : "open";
      await tx.run(
        `UPDATE checklist_items SET status = ?, statusChangedAt = ?, statusChangedBy = ?,
         statusReason = ?, lastUpdatedAt = ?, updated_by = ? WHERE id = ?`,
        [
          status,
          now,
          actor.id,
          action.action === "restore" || !action.reason ? null : scrubSecrets(action.reason),
          now,
          actor.id,
          id,
        ],
      );
    }
    return id;
  });
  const items = await listChecklist(actor.userId, actor.canEditSwarm);
  return items.find((item) => item.id === id)!;
}

export async function firstOpenItem(userId: string | null): Promise<ChecklistItem | null> {
  return (
    (await listChecklist(userId)).find(
      (item) => item.status === "open" && item.signal === false && item.nudgedAt === null,
    ) ?? null
  );
}

export async function markNudged(itemId: string, taskId: string): Promise<void> {
  const now = new Date().toISOString();
  await getDbClient().run(
    "UPDATE checklist_items SET nudgedAt = ?, nudgedTaskId = ?, lastUpdatedAt = ? WHERE id = ?",
    [now, taskId, now, itemId],
  );
}
