import type {
  SessionGroupSpec,
  SessionInboxScope,
  SessionReadStateSpec,
  SessionRootFilterSpec,
  SessionSummarySpec,
  SessionTreeRules,
  SqlQuery,
} from "@desplega/storage";
import {
  isGroupKey,
  isResourceGroupPrefix,
  keyPrefixRange,
  NO_GROUP_LEAF_KINDS,
  normalizeAssetKey,
  parseAssetKey,
  SESSION_LEAF_KINDS,
  SESSION_RESOURCE_KINDS,
  sessionGroupKey,
  sessionResourceGroupOf,
} from "../../assets/key";
import {
  effectiveSource,
  isSourceThreadKey,
  NESTED_THREAD_MIN_ROOTS,
  SESSION_SOURCES,
  sessionThreadGroupKey,
  sourceOfKey,
} from "../../assets/source-key";
import { isTerminalTaskStatus, TERMINAL_TASK_STATUSES } from "../../types";
import { literalPrefixPattern } from "../db";
import type { DbParam } from "../db-client";
import { getStorage } from "../storage";
import {
  HUMAN_SYSTEM_TASK_TYPES,
  MACHINE_SESSION_SOURCES,
  type SessionViewer,
} from "./session-visibility";

export type SessionReadState = "unread" | "read" | "later" | "done";
export interface SessionFilters {
  /** Restrict roots to these raw task sources (`agent_tasks.source`). */
  source?: string[];
  /**
   * Leave out roots of these effective sources (the older sessions v2 source
   * filter). The effective source of a root under a source key prefix such as
   * `shared/slack/` is that source, else its raw task source.
   */
  hideSource?: string[];
  /**
   * Keep only roots of these effective sources (the sessions v2 source filter,
   * see `hideSource`). Unlike `source`, an empty list matches no root.
   */
  showSource?: string[];
  /** Match root task text or title with a case-insensitive substring. */
  q?: string;
  /** Match the root requester, excluding NULL requester rows. */
  requestedByUserId?: string;
  /** Literal context prefix for the UI session panel, escaping %, _ and backslash. */
  contextKeyPrefix?: string;
  /** Apply this user's session ownership and share visibility. */
  viewer?: SessionViewer;
  /** Match roots under this literal canonical asset key prefix. */
  keyPrefix?: string;
  /** Match roots under any of these prefixes, one indexed range each. */
  keyPrefixes?: string[];
  /** Match this exact group and its direct resource leaves. */
  groupKey?: string;
  /** Match shared and viewer-personal namespace roots and direct leaves. */
  noGroup?: boolean;
  /** Filter by chain-wide read state or the Inbox section. */
  triage?: "inbox" | "working" | "later" | "done" | "unread";
  /** Filter by latest chain status or pending human attention. */
  status?: "running" | "failed" | "needs";
  /** Match a requester anywhere in the chain or an active share recipient. */
  withUserId?: string;
  /** Use this ISO timestamp for read-state comparisons. */
  now?: string;
  /** Exclude ownerless roots for user viewers to match the tree's visibility. */
  tree?: boolean;
  /** For user viewers: only human-started roots of the viewer and shares (the "Mine" view). */
  mine?: boolean;
  /**
   * Include every schedule run despite Mine, shown-source, and tree owner
   * filters. Only `getSessionTree` sets it, and it applies the rule per row.
   * A `groupKey` of a user group ({@link showsScheduleRuns}) turns it on by
   * itself, so the list and its bulk triage agree.
   */
  includeScheduleRuns?: boolean;
  /** Match exactly this root (one session's summary, e.g. its read state). */
  rootId?: string;
  /** Match any of these roots (the sidebar's starred sessions). */
  rootIds?: string[];
  /** Leave these roots out (a whole-list triage with some rows unchecked). */
  exceptRootIds?: string[];
}

type SqlFragment = { sql: string; params: DbParam[] };

const sessionsRepo = () => getStorage().repos.sessions;

/** A repository fragment as text and parameters, for callers that still splice SQL text. */
function rendered(query: SqlQuery): SqlFragment {
  const { text, params } = query.render(getStorage().dialect);
  return { sql: text, params };
}

/** How long a finished, read Inbox session stays quiet before it moves to Done on its own. */
const AUTO_DONE_QUIET_MS = 24 * 3600000;

/**
 * Sources of tasks that agents and the server create: delegation and scripts
 * (`mcp`), follow-ups (`system`), deferred wake-ups (`schedule`) and workflow
 * steps. Agents also set `requestedByUserId` explicitly on these, so a requester
 * alone does not mark a human message (the legacy chain walk's reopen rule).
 */
const AGENT_TASK_SOURCES = ["mcp", "system", "schedule", "workflow"] as const;

function sourceKeyRanges() {
  return SESSION_SOURCES.map((source) => ({ source, ...keyPrefixRange(`shared/${source}/`) }));
}

/** The key and status rules the session tree SQL applies. */
function treeRules(): SessionTreeRules {
  return {
    sourceRanges: sourceKeyRanges(),
    nestedThreadMinRoots: NESTED_THREAD_MIN_ROOTS,
    terminalStatuses: TERMINAL_TASK_STATUSES,
    agentTaskSources: AGENT_TASK_SOURCES,
    machineSources: MACHINE_SESSION_SOURCES,
    humanSystemTaskTypes: HUMAN_SYSTEM_TASK_TYPES,
  };
}

/**
 * Shared read-state rule with bound ISO timestamps for the list and tree.
 * Done holds through agent activity (progress, status changes, child tasks):
 * only `reopensDone` brings it back.
 *
 * Auto-Done: an Inbox session (`inboxScope` on its root `r`) reads
 * as Done once it reads as read, every chain task is finished, no approval
 * waits, and neither the chain nor the viewer's triage row changed for 24
 * hours. Nothing is written, so any new activity brings it back to the Inbox,
 * and a "back to Inbox" (which writes the row) holds for another 24 hours.
 * Later, Done marks, and groups are never auto-Done.
 */
function readStateSpec(
  userId: string | null | undefined,
  now = new Date().toISOString(),
): SessionReadStateSpec {
  return {
    now,
    unreadSince: new Date(Date.parse(now) - 7 * 86400000).toISOString(),
    quietBefore: new Date(Date.parse(now) - AUTO_DONE_QUIET_MS).toISOString(),
    inbox: inboxScope(userId),
  };
}

/** Count every owned root at the exact source thread key, independent of viewer filters. */
export function threadRootsSql(): SqlFragment {
  return rendered(sessionsRepo().sessionThreadRootsSql(treeRules()));
}

/** {@link threadRootsSql} for every source thread key at once: one grouped read for the tree. */
async function threadRootCounts(): Promise<Map<string, number>> {
  const rows = await sessionsRepo().listThreadRootCounts(treeRules());
  return new Map(rows.map((row) => [row.key, row.threadRoots]));
}

/** A task's group with the list row's rule (`groupKey` on `GET /api/sessions`). */
export async function getSessionGroupKey(task: { id: string; key: string }): Promise<string> {
  const threadRoots = await sessionsRepo().findTaskThreadRoots(treeRules(), task.id);
  return sessionThreadGroupKey(task.key, threadRoots ?? 0);
}

/**
 * `scan` keeps the key index out of the range (unary `+`). A broad prefix such
 * as `shared/` holds most roots, where one pass over the narrow summaries
 * beats an index lookup per row; without planner statistics SQLite cannot tell.
 */
function groupSpec(group: string, scan = false): SessionGroupSpec {
  const { lo, hi } = keyPrefixRange(group);
  // A namespace root keeps resource leaves out: they are resource groups (`sessionGroupKey`).
  const kinds =
    parseAssetKey(group).relativeSegments.length === 0 ? NO_GROUP_LEAF_KINDS : SESSION_LEAF_KINDS;
  // The remaining key must be one resource leaf, with no nested path.
  // SQLite substr/length count code points, so count them here too (not UTF-16 units).
  const start = [...lo].length + 1;
  return { lo, hi, scan, start, leafPatterns: kinds.map((kind) => `${kind}:?*/`) };
}

/** No group: roots at `shared/` and at the viewer's `personal/<me>/`, with their direct leaves. */
function noGroupSpecs(userId: string | null | undefined): SessionGroupSpec[] {
  const groups = [groupSpec("shared/", true)];
  if (userId) groups.push(groupSpec(`personal/${userId}/`, true));
  return groups;
}

/** The namespace roots whose resource groups the Inbox holds: `shared/` and the viewer's own. */
function resourceBases(userId: string | null | undefined): string[] {
  return userId ? ["shared/", `personal/${userId}/`] : ["shared/"];
}

/**
 * Whether a root key sits in a resource section (Pages, Workflows, ...) of
 * the viewer: `inboxScope`'s resource ranges, in JS.
 */
export function inResourceScope(key: string, userId: string | null | undefined): boolean {
  return resourceBases(userId).some((base) =>
    SESSION_RESOURCE_KINDS.some((kind) => key.startsWith(`${base}${kind}:`)),
  );
}

/** Key ranges of every `<base><kind>:` prefix ({@link inResourceScope}). */
function resourceKeyRanges(userId: string | null | undefined) {
  return resourceBases(userId).flatMap((base) =>
    SESSION_RESOURCE_KINDS.map((kind) => {
      const lo = normalizeAssetKey(`${base}${kind}:`).slice(0, -1);
      return { lo, hi: `${lo.slice(0, -1)};` };
    }),
  );
}

/**
 * Roots the Inbox holds: No group, the source sections (Slack, Telegram,
 * Discord), and the resource sections (Pages, Workflows, ...), which file
 * sessions on their own. A session that a person filed into a group (My
 * groups, Shared with me) shows under that group only.
 */
function inboxScope(userId: string | null | undefined): SessionInboxScope {
  return {
    ranges: [...sourceKeyRanges(), ...resourceKeyRanges(userId)],
    noGroup: noGroupSpecs(userId),
  };
}

/**
 * A user group (not a namespace root, a resource group, or a source group)
 * shows the schedule runs filed in it, whoever owns them and whatever the
 * source filter says. The list (`groupKey`) and the tree counts use this rule.
 */
export function showsScheduleRuns(groupKey: string): boolean {
  return isGroupKey(groupKey) && !sourceOfKey(groupKey) && !isResourceGroupPrefix(groupKey);
}

/**
 * Conditions on a session root `r`: a `session_summaries` row or a root task
 * (`legacySessionSummaryQuery`). Only `q` reads the root task itself.
 */
function rootFilterSpec(opts: SessionFilters): SessionRootFilterSpec {
  const spec: SessionRootFilterSpec = {
    includeScheduleRuns:
      opts.includeScheduleRuns || (!!opts.groupKey && showsScheduleRuns(opts.groupKey)),
  };
  if (opts.rootId) spec.rootId = opts.rootId;
  if (opts.rootIds) spec.rootIds = opts.rootIds;
  if (opts.exceptRootIds?.length) spec.exceptRootIds = opts.exceptRootIds;
  const sources = opts.source?.filter(Boolean) ?? [];
  if (sources.length) spec.sources = sources;
  const hidden = opts.hideSource?.filter(Boolean) ?? [];
  if (hidden.length) spec.hideSources = hidden;
  if (opts.showSource) spec.showSources = opts.showSource.filter(Boolean);
  if (opts.q?.trim()) spec.textLike = `%${opts.q.trim().toLowerCase()}%`;
  if (opts.requestedByUserId?.trim()) spec.requestedByUserId = opts.requestedByUserId.trim();
  if (opts.contextKeyPrefix) spec.contextKeyPattern = literalPrefixPattern(opts.contextKeyPrefix);
  if (opts.viewer) {
    spec.viewer = opts.viewer;
    spec.tree = opts.tree;
    spec.mine = opts.mine;
  }
  if (opts.keyPrefix) spec.keyRange = keyPrefixRange(opts.keyPrefix);
  if (opts.keyPrefixes?.length) spec.keyRanges = opts.keyPrefixes.map(keyPrefixRange);
  if (opts.groupKey) spec.group = groupSpec(normalizeAssetKey(opts.groupKey));
  if (opts.noGroup) spec.noGroup = noGroupSpecs(opts.viewer?.userId);
  if (opts.triage === "inbox" || opts.triage === "working") {
    spec.inbox = inboxScope(opts.viewer?.userId);
  }
  if (opts.triage === "later" || opts.triage === "done") {
    // Done also holds auto-Done Inbox sessions, which have no Done row.
    spec.marked = {
      triage: opts.triage,
      userId: opts.viewer?.userId ?? null,
      orInbox:
        opts.triage === "done" && opts.viewer?.userId ? inboxScope(opts.viewer.userId) : undefined,
    };
  }
  return spec;
}

export function sessionRootFilter(opts: SessionFilters = {}): SqlFragment {
  return rendered(sessionsRepo().sessionRootFilterSql(treeRules(), rootFilterSpec(opts)));
}

/**
 * A group list leaves out the viewer's Later and Done sessions: they list in
 * Later and Done. A source group (`shared/slack/...`) keeps them. It mirrors
 * an outside conversation, read-only, and most of its sessions are Done, so
 * leaving them out left its rows empty with no way to open them.
 */
function excludesTriaged(opts: SessionFilters): boolean {
  // The sidebar lists a source group with its nested threads by `keyPrefix`: same rule.
  if (sourceOfKey(opts.groupKey ?? opts.keyPrefix ?? "")) return false;
  return !!(
    opts.viewer?.userId &&
    (opts.groupKey || opts.keyPrefix || opts.keyPrefixes?.length || opts.noGroup)
  );
}

function hasSessionChainFilter(opts: SessionFilters): boolean {
  return !!(opts.triage || opts.status || opts.withUserId || excludesTriaged(opts));
}

/** The summary filters: root conditions, the viewer's read state, row filters. */
function summarySpec(opts: SessionFilters): SessionSummarySpec {
  const userId = opts.viewer?.userId;
  return {
    root: rootFilterSpec(opts),
    read: userId ? readStateSpec(userId, opts.now) : undefined,
    viewerUserId: userId ?? null,
    withUserId: opts.withUserId,
    triage: opts.triage,
    status: opts.status,
    excludesTriaged: excludesTriaged(opts),
  };
}

/**
 * One row per visible session root, with its chain aggregates, the viewer's
 * read state and `needsYou`. It reads the trigger-kept `session_summaries`, so
 * no request walks a chain: root filters, then one primary-key join for the
 * viewer's triage row. Same rule and columns as {@link legacySessionSummaryQuery},
 * plus the root columns the list and tree order and group by.
 */
export function sessionSummaryQuery(opts: SessionFilters = {}): SqlFragment {
  return rendered(sessionsRepo().sessionSummarySql(treeRules(), summarySpec(opts)));
}

/**
 * The chain walk the summaries replace: a session starts at a parentTaskId IS
 * NULL root, and one recursive CTE computes chain-wide latest activity. Root
 * filters precede recursion; read state and chain filters follow aggregation.
 * Off the request path: tests compare {@link sessionSummaryQuery} with it.
 */
export function legacySessionSummaryQuery(opts: SessionFilters = {}): SqlFragment {
  return rendered(sessionsRepo().legacySessionSummarySql(treeRules(), summarySpec(opts)));
}

/** One page of the session list: root rows with their summary columns (see the repository). */
export function listSessionPageRows<T>(
  opts: SessionFilters & { triage?: string; limit?: number; offset?: number },
): Promise<T[]> {
  return sessionsRepo().listSessionPage<T>(treeRules(), summarySpec(opts), {
    snoozeFirst: opts.triage === "later",
    limit: opts.limit ?? 25,
    offset: opts.offset ?? 0,
  });
}

/** True when a row of the session summary for `opts` has read state `read`. */
export async function hasReadSession(opts: SessionFilters): Promise<boolean> {
  return sessionsRepo().hasReadSession(treeRules(), summarySpec(opts));
}

/**
 * One session's read state for a user, with the same rule and chain activity
 * as the list rows. Null when the user cannot see the root.
 */
export async function getSessionReadState(
  rootId: string,
  userId: string,
  now?: string,
  readAll?: boolean,
): Promise<{ readState: SessionReadState; lastActivityAt: string } | null> {
  const row = await sessionsRepo().findSessionReadState(
    treeRules(),
    summarySpec({ rootId, viewer: { userId, scope: "all", readAll }, now }),
  );
  return row?.readState
    ? { readState: row.readState as SessionReadState, lastActivityAt: row.lastActivityAt }
    : null;
}

/** Count roots directly unless a filter needs chain activity or participants. */
/** Count roots directly unless a filter needs chain activity or participants. */
export async function countSessionRoots(opts: SessionFilters = {}): Promise<number> {
  return sessionsRepo().countSessions(treeRules(), summarySpec(opts), hasSessionChainFilter(opts));
}

export function sessionCountQuery(opts: SessionFilters = {}): SqlFragment {
  return rendered(
    sessionsRepo().sessionCountSql(treeRules(), summarySpec(opts), hasSessionChainFilter(opts)),
  );
}

export interface SessionRowFields {
  readState?: SessionReadState;
  snoozeUntil?: string | null;
  needsYou?: boolean;
  groupKey?: string;
  shared?: boolean;
  people?: { id: string; name: string }[];
  peopleCount?: number;
  preview?: string | null;
  /** Active shares with their access. `userId` null means everyone on the swarm. */
  shares?: { userId: string | null; name: string | null; access: "read" | "write" }[];
}

/** Two page-wide queries load people, shares and bounded output previews. */
export async function sessionPageFields(
  roots: { id: string; requestedByUserId?: string }[],
): Promise<Map<string, SessionRowFields>> {
  const result = new Map<string, SessionRowFields>();
  if (!roots.length) return result;
  const ids = roots.map((r) => r.id);
  const [tasks, shares] = await Promise.all([
    sessionsRepo().listSessionPageMembers(ids),
    sessionsRepo().listSessionPageShares(ids),
  ]);
  const people = new Map<string, Map<string, string>>();
  for (const root of roots) {
    result.set(root.id, { shared: false, preview: null, shares: [] });
    people.set(root.id, new Map());
  }
  // Chain rows are newest first. Reserve the requester slot before adding other people.
  for (const root of roots) {
    if (!root.requestedByUserId) continue;
    people.get(root.id)!.set(root.requestedByUserId, root.requestedByUserId);
  }
  for (const task of tasks) {
    if (task.id) people.get(task.root_id)!.set(task.id, task.name ?? task.id);
    const fields = result.get(task.root_id)!;
    if (fields.preview === null && task.preview !== null) fields.preview = task.preview;
  }
  for (const share of shares) {
    const fields = result.get(share.root_id)!;
    fields.shared = true;
    fields.shares!.push({ userId: share.id, name: share.name, access: share.access });
    if (share.id) people.get(share.root_id)!.set(share.id, share.name ?? share.id);
  }
  for (const [id, members] of people) {
    Object.assign(result.get(id)!, {
      people: [...members].slice(0, 8).map(([id, name]) => ({ id, name })),
      peopleCount: members.size,
    });
  }
  return result;
}

export interface SessionSectionCounts {
  total: number;
  unread: number;
  running: number;
  needsYou: number;
}
export interface SessionTreeGroup extends SessionSectionCounts {
  key: string;
  lastActivityAt: string;
}

export interface SessionTree {
  groups: SessionTreeGroup[];
  inbox: SessionSectionCounts;
  /** Inbox sessions with a task running and nothing for the person to answer. */
  working: SessionSectionCounts;
  later: SessionSectionCounts;
  done: SessionSectionCounts;
  noGroup: SessionSectionCounts;
  /** Each effective root source in this view with its session count, hidden sources included, most first. */
  sources: { source: string; total: number }[];
  /** Every source group key in this view, hidden sources included, so a pane of a hidden source still gets its label. */
  sourceGroups: string[];
  /** Slack channel ids backed by visible roots with matching Slack fields, including hidden sources. */
  slackChannels: string[];
  /**
   * Every resource group key in this view and the key of its resource
   * (`shared/app:<id>/` for an action group), hidden sources included, for labels.
   */
  resourceGroups: string[];
  /**
   * The oldest visible root of each nested source thread, including hidden
   * sources: its title, else a preview of its prompt without the thread context.
   */
  threadLabels: Record<string, string>;
}

/**
 * The first `<thread_context>` block of a prompt, as the Slack and Chat SDK
 * templates write it (each tag alone on its line). It holds the earlier thread
 * messages, so a label cut from the start of the prompt never reaches the ask.
 */
/**
 * The task list preview length. The UI reads this length plus "…" as a list
 * preview and repairs a Slack token or a block that the cut splits
 * (`isListPreview` in `apps/ui/src/lib/prompt-display.ts`).
 */
const THREAD_LABEL_LENGTH = 300;
/** Extra characters for the blank lines that `threadPromptPreview` trims, so the preview stays full. */
const THREAD_LABEL_TRIM_MARGIN = 100;

function threadPromptPreview(prompt: string): string {
  const text = prompt.trim();
  return text.length > THREAD_LABEL_LENGTH ? `${text.slice(0, THREAD_LABEL_LENGTH)}…` : text;
}

export async function getSessionTree(
  actor: { kind: "bypass" } | { kind: "user"; userId: string | null; readAll?: boolean },
  now?: string,
  opts: { mine?: boolean; hideSource?: string[]; showSource?: string[] } = {},
): Promise<SessionTree> {
  // No source filter in SQL: the source counts must include hidden sources,
  // so the filter menu can offer them back. The loop skips them instead.
  const filterOpts: SessionFilters = {
    ...(actor.kind === "user"
      ? { viewer: { userId: actor.userId, scope: "all", readAll: actor.readAll } as const }
      : {}),
    now,
    tree: true,
    mine: opts.mine,
  };
  const spec = summarySpec({ ...filterOpts, includeScheduleRuns: true });
  // The query relaxes the owner and Mine rules for schedule runs. A row outside
  // a user group still needs them (the predicates `rootFilterSpec` relaxes).
  const viewer = filterOpts.viewer;
  const [rows, threadRoots] = await Promise.all([
    sessionsRepo().listSessionTreeRows(
      treeRules(),
      spec,
      viewer ? { mine: !!opts.mine, userId: viewer.userId, readAll: viewer.readAll } : null,
    ),
    threadRootCounts(),
  ]);
  const counts = (): SessionSectionCounts => ({ total: 0, unread: 0, running: 0, needsYou: 0 });
  const result: SessionTree = {
    groups: [],
    inbox: counts(),
    working: counts(),
    later: counts(),
    done: counts(),
    noGroup: counts(),
    sources: [],
    sourceGroups: [],
    slackChannels: [],
    resourceGroups: [],
    threadLabels: {},
  };
  const hidden = new Set(opts.hideSource);
  const shown = opts.showSource ? new Set(opts.showSource) : null;
  const sources = new Map<string, number>();
  const sourceGroups = new Set<string>();
  const slackChannels = new Set<string>();
  const resourceGroups = new Set<string>();
  const threadRootIds: string[] = [];
  const groups = new Map<string, SessionTreeGroup>();
  const add = (section: SessionSectionCounts, row: (typeof rows)[number]) => {
    section.total++;
    if (row.readState === "unread") section.unread++;
    if (!isTerminalTaskStatus(row.latestStatus)) section.running++;
    if (row.needsYou) section.needsYou++;
  };
  for (const row of rows) {
    const source = effectiveSource(row.key, row.source);
    const rowThreadRoots = threadRoots.get(row.key) ?? 0;
    const key = sessionThreadGroupKey(row.key, rowThreadRoots);
    const groupedSchedule = row.scheduleId !== null && showsScheduleRuns(key);
    if (!groupedSchedule && !row.defaultVisible) continue;
    sources.set(source, (sources.get(source) ?? 0) + 1);
    const sourceGroupKey = sessionGroupKey(row.key);
    const channelId = /^shared\/slack\/([^/]+)\/$/.exec(sourceGroupKey)?.[1];
    if (channelId && row.slackChannelId?.toLowerCase() === channelId) {
      slackChannels.add(channelId);
    }
    if (rowThreadRoots >= NESTED_THREAD_MIN_ROOTS && isSourceThreadKey(row.key)) {
      threadRootIds.push(row.root_id);
      sourceGroups.add(sourceGroupKey);
    }
    if (sourceOfKey(key)) sourceGroups.add(key);
    const resource = sessionResourceGroupOf(key);
    if (resource) resourceGroups.add(key).add(resource.resourceKey);
    if (hidden.has(source) || (shown && !shown.has(source) && !groupedSchedule)) continue;
    // The relaxation is for the group count only. Inbox, Later and Done lists keep
    // the owner, Mine and shown-source rules, so their counts do too.
    const sectionVisible = !!row.defaultVisible && (!shown || shown.has(source));
    const noGroup =
      key === "shared/" || (actor.kind === "user" && key === `personal/${actor.userId}/`);
    let group: SessionTreeGroup | undefined;
    if (!noGroup) {
      group = groups.get(key);
      if (!group) {
        group = { key, ...counts(), lastActivityAt: row.lastActivityAt };
        groups.set(key, group);
      }
      if (row.lastActivityAt > group.lastActivityAt) group.lastActivityAt = row.lastActivityAt;
    }
    if (row.readState === "later" || row.readState === "done") {
      if (sectionVisible) add(result[row.readState], row);
      // A source group lists its Later and Done sessions too (`excludesTriaged`).
      if (group && sourceOfKey(key)) add(group, row);
    } else {
      // A session filed into a group shows under it only (`inboxScopeCondition`).
      const viewer = actor.kind === "user" ? actor.userId : null;
      const inInbox = noGroup || sourceOfKey(key) || inResourceScope(row.key, viewer);
      const working = !isTerminalTaskStatus(row.latestStatus) && !row.needsYou;
      if (sectionVisible && inInbox) add(working ? result.working : result.inbox, row);
      if (noGroup) add(result.noGroup, row);
      else if (group) add(group, row);
    }
  }
  result.groups = [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
  result.sources = [...sources]
    .map(([source, total]) => ({ source, total }))
    .sort((a, b) => b.total - a.total || a.source.localeCompare(b.source));
  result.sourceGroups = [...sourceGroups].sort();
  result.slackChannels = [...slackChannels].sort();
  result.resourceGroups = [...resourceGroups].sort();
  if (threadRootIds.length) {
    // A missing or empty title falls back to a preview of the prompt without its thread context.
    const labels = await sessionsRepo().listThreadLabels(
      threadRootIds,
      THREAD_LABEL_LENGTH + THREAD_LABEL_TRIM_MARGIN,
    );
    result.threadLabels = Object.fromEntries(
      labels.map((row) => [row.key, row.title ?? threadPromptPreview(row.prompt)]),
    );
  }
  return result;
}

/** Triage actions on a whole list: the bulk bar's "Select all N". */
export type SessionListTriage = "done" | "inbox" | "read" | "unread";

/** The read cursor of "unread". The dashboard and the my-swarm app write the same value. */
const UNREAD_CURSOR = "1970-01-01T00:00:00.000Z";

/**
 * Apply one triage action to every session a sidebar list shows `userId`
 * (the same filters as `GET /api/sessions?scope=tree`), in one statement.
 * The rows match what the dashboard writes for one session: Done, back to
 * the Inbox, read up to the newest activity, or unread. Returns the number
 * of sessions written.
 */
export async function triageSessionList(
  userId: string,
  filters: Pick<
    SessionFilters,
    | "triage"
    | "noGroup"
    | "groupKey"
    | "keyPrefix"
    | "mine"
    | "hideSource"
    | "showSource"
    | "now"
    | "exceptRootIds"
  >,
  action: SessionListTriage,
  readAll?: boolean,
): Promise<number> {
  const now = filters.now ?? new Date().toISOString();
  const spec = summarySpec({
    ...filters,
    now,
    viewer: { userId, scope: "all", readAll },
    tree: true,
  });
  // `read` moves the cursor to each session's newest activity, `unread` to the epoch.
  // The conflict rules copy `upsertInboxState` in src/be/db.ts (sticky readAt,
  // lastReadAt only when the action sets it, snooze and dismiss cleared). Keep
  // the two in step.
  return sessionsRepo().triageSessionList(treeRules(), spec, {
    userId,
    status: action === "done" ? "done" : "open",
    doneAt: action === "done" ? now : null,
    readAt: action === "read" ? now : null,
    now,
    lastReadAt:
      action === "read"
        ? { kind: "activity" }
        : action === "unread"
          ? { kind: "value", value: UNREAD_CURSOR }
          : undefined,
  });
}
