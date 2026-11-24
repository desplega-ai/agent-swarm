import { isGroupKey } from "../assets/key";
import { healthyChatSdkAdapters } from "../integrations/chat-sdk/status";
import { isRbacEnabled } from "../rbac";
import type { ChecklistItem } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getAutomationSetupStates, setupIntegrationFlags } from "./automation-preflight";
import { hasReadSession } from "./db/session-tree";
import { hasOAuthTokens } from "./db-queries/oauth";
import { getUserGrant } from "./rbac-roles";
import { getStorage } from "./storage";

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
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
  }
}

/** Fixed so unstored defaults serialize the same on every read. */
const UNSTORED_DEFAULT_AT = "1970-01-01T00:00:00.000Z";

/**
 * Whether the user's grants allow editing swarm-wide checklist items.
 * Null when RBAC is off: role rows count only with RBAC on, so the caller applies the legacy policy.
 */
export async function userGrantCanEditSwarm(userId: string): Promise<boolean | null> {
  if (!isRbacEnabled()) return null;
  const grant = await getUserGrant(userId);
  return grant.grantsAll || grant.verbs.has("config.write.any");
}

/** The default rows every list starts with: two swarm items and the reader's use case. */
function defaultRows(userId: string | null): ChecklistRow[] {
  const row = (
    id: string,
    scope: ChecklistRow["scope"],
    kind: ChecklistRow["kind"],
    label: string,
    href: string,
    sortOrder: number,
  ): ChecklistRow => ({
    id,
    scope,
    userId: scope === "user" ? userId : null,
    kind,
    label,
    href,
    meta: null,
    sortOrder,
    status: "open",
    statusChangedAt: null,
    statusChangedBy: null,
    statusChangedByName: null,
    statusReason: null,
    nudgedAt: null,
    nudgedTaskId: null,
    createdAt: UNSTORED_DEFAULT_AT,
    lastUpdatedAt: UNSTORED_DEFAULT_AT,
  });
  return [
    row("swarm:channel", "swarm", "channel", "Connect a chat channel", "/integrations/channels", 0),
    row("swarm:tool", "swarm", "tool", "Connect work tools", "/integrations/tools", 1),
    ...(userId
      ? [
          row(
            `user:${userId}:use_case`,
            "user",
            "use_case",
            "Plan your first use case",
            "/sessions",
            2,
          ),
        ]
      : []),
  ];
}

/** Write paths only: reads merge the defaults in memory and take no write lock. */
async function seedChecklist(userId: string | null): Promise<void> {
  await getStorage().repos.tasks.seedChecklistDefaults(userId);
}

/** Stored rows plus any default not stored yet, in list order. */
async function checklistRows(userId: string | null): Promise<ChecklistRow[]> {
  const rows = (await getStorage().repos.tasks.listChecklistRows(userId)) as ChecklistRow[];
  const stored = new Set(rows.map((row) => row.id));
  const all = [...rows, ...defaultRows(userId).filter((row) => !stored.has(row.id))];
  // Same order as `ORDER BY sortOrder, createdAt, id`.
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return all.sort(
    (a, b) => a.sortOrder - b.sortOrder || cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id),
  );
}

/** A stored meta that is not a JSON object reads as no meta, never as an error. */
function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function getUseCaseSignal(userId: string | null): Promise<boolean> {
  if (!userId) return false;
  // Apps have keys but no creator column. See .non-audit-tables.
  // Bound the check to the user's 100 most recently created group keys.
  // The SQL LIMIT bounds the distinct keys read before the group-key filter.
  const keys = await getStorage().repos.assets.listUserCreatedKeys(userId, 500);
  const groups = keys.filter(isGroupKey).slice(0, 100);
  if (groups.length === 0) return false;
  return hasReadSession({ keyPrefixes: groups, viewer: { userId, scope: "all" } });
}

/** Each signal is computed at most once per call, and only when a row needs it. */
function lazySignals(userId: string | null) {
  const once = <T>(fn: () => Promise<T>) => {
    let value: Promise<T> | undefined;
    return () => {
      value ??= fn();
      return value;
    };
  };
  const flags = once(async () => setupIntegrationFlags(await getAutomationSetupStates()));
  const adapters = once(async () => {
    const names = new Set<string>(healthyChatSdkAdapters());
    if ((await flags()).slack) names.add("slack");
    return names;
  });
  const tool = once(async () => {
    const f = await flags();
    if (f.github || f.gitlab || f.bitbucket || f.linear || f.jira) return true;
    return (await hasOAuthTokens("google")) || (await hasOAuthTokens("microsoft"));
  });
  const plannedUseCase = once(() => getUseCaseSignal(userId));
  return async (row: ChecklistRow, meta: Record<string, unknown> | null) => {
    if (row.kind === "custom") return null;
    if (row.kind === "channel") {
      const names = await adapters();
      return typeof meta?.adapter === "string" ? names.has(meta.adapter) : names.size > 0;
    }
    return row.kind === "tool" ? tool() : plannedUseCase();
  };
}

function toItem(
  row: ChecklistRow,
  meta: Record<string, unknown> | null,
  signal: boolean | null,
  userId: string | null,
  canEditSwarm: boolean,
): ChecklistItem {
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
}

/**
 * Read-only: the dashboard polls this. `signal` is null for custom items and
 * for items marked done by hand, which need no check.
 */
export async function listChecklist(
  userId: string | null,
  canEditSwarm = false,
): Promise<ChecklistItem[]> {
  const signalOf = lazySignals(userId);
  return Promise.all(
    (await checklistRows(userId)).map(async (row) => {
      const meta = parseMeta(row.meta);
      const signal = row.status === "done" ? null : await signalOf(row, meta);
      return toItem(row, meta, signal, userId, canEditSwarm);
    }),
  );
}

export async function mutateChecklist(
  actor: ChecklistActor,
  action: ChecklistAction,
): Promise<ChecklistItem> {
  const repo = getStorage().repos.tasks;
  const id = await getStorage().transaction(async () => {
    await seedChecklist(actor.userId);
    const id = action.action === "add" ? crypto.randomUUID() : action.id;
    const row =
      action.action === "add"
        ? action
        : ((await repo.findChecklistItem(id)) as ChecklistRow | null);
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
      const adapter = action.kind === "channel" ? action.meta?.adapter : undefined;
      if (typeof adapter === "string") {
        const open = await repo.findOpenChannelChecklistItem(action.scope, userId, adapter);
        if (open) throw new ChecklistError(`An open item already connects ${adapter}`, 409);
      }
      const sortOrder = await repo.nextChecklistSortOrder(action.scope, userId);
      await repo.insertChecklistItem({
        id,
        scope: action.scope,
        userId,
        kind: action.kind,
        // Free text from users and the Lead: keep recognisable secrets out at rest.
        label: scrubSecrets(action.label),
        href: action.href ? scrubSecrets(action.href) : null,
        meta: action.meta ? scrubSecrets(JSON.stringify(action.meta)) : null,
        sortOrder,
        now,
        actor: actor.id,
      });
    } else if (action.action === "reorder") {
      await repo.setChecklistSortOrder(id, action.sortOrder, now, actor.id);
    } else {
      const status =
        action.action === "remove" ? "removed" : action.action === "done" ? "done" : "open";
      await repo.setChecklistStatus(
        id,
        status,
        action.action === "restore" || !action.reason ? null : scrubSecrets(action.reason),
        now,
        actor.id,
      );
    }
    return id;
  });
  const items = await listChecklist(actor.userId, actor.canEditSwarm);
  return items.find((item) => item.id === id)!;
}

/** The first open, editable, not-nudged item without a signal. Checks stop at the match. */
export async function firstOpenItem(
  userId: string | null,
  canEditSwarm: boolean,
): Promise<ChecklistItem | null> {
  const signalOf = lazySignals(userId);
  for (const row of await checklistRows(userId)) {
    const editable = row.scope === "swarm" ? canEditSwarm : row.userId === userId;
    if (!editable || row.status !== "open" || row.nudgedAt !== null) continue;
    const meta = parseMeta(row.meta);
    const signal = await signalOf(row, meta);
    if (signal === false) return toItem(row, meta, signal, userId, canEditSwarm);
  }
  return null;
}

/** A write path: stores the default rows first, so a default item keeps its nudge. */
export async function markNudged(
  itemId: string,
  taskId: string,
  userId: string | null,
): Promise<void> {
  await seedChecklist(userId);
  const now = new Date().toISOString();
  await getStorage().repos.tasks.markChecklistNudged(itemId, taskId, now);
}
