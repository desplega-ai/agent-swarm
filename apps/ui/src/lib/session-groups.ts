// Sessions v2 sidebar: nest the flat `groups` of `GET /api/session-tree` into
// My groups, Shared with me, and the source sections, and add up the counts
// of folded groups.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { AgentTask, SessionSectionCounts, SessionTreeGroup } from "../api/types";
import { promptTitle } from "./prompt-display";

/** The external sources with their own sidebar section. Mirrors `src/assets/source-key.ts`. */
export const SESSION_SOURCES = ["slack", "telegram", "discord"] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

/** The source of a key under `shared/<source>/`, or null. */
export function sourceOfGroupKey(key: string): SessionSource | null {
  return SESSION_SOURCES.find((source) => key.startsWith(`shared/${source}/`)) ?? null;
}

/**
 * Where a session came from: the source of its key (`shared/slack/…`, so an
 * agent session in a Slack thread is Slack), else the chat adapter of a
 * `chat` root (its `telegram` or `discord` tag), else the task source.
 */
export function sessionSourceOf(root: Pick<AgentTask, "key" | "source" | "tags">): string {
  const fromKey = sourceOfGroupKey(root.key ?? "");
  if (fromKey) return fromKey;
  if (root.source === "chat") {
    return root.tags?.find((tag) => (SESSION_SOURCES as readonly string[]).includes(tag)) ?? "chat";
  }
  return root.source;
}

/** The sources whose sessions show their mark before the title: the chats. */
const CHAT_SOURCES: ReadonlySet<string> = new Set([...SESSION_SOURCES, "chat"]);

/** The chat source of a session (Slack, Telegram, Discord, chat), or null for any other source. */
export function chatSourceOf(root: Pick<AgentTask, "key" | "source" | "tags">): string | null {
  const source = sessionSourceOf(root);
  return CHAT_SOURCES.has(source) ? source : null;
}

/** One group (an asset key prefix) in the sidebar tree. */
export interface GroupNode {
  /** The group key (`shared/northwind/pricing/`). It is also the fold id and the `?view=` value. */
  key: string;
  /**
   * What the row shows: the last segment, the path below the owner under
   * Shared with me, or a source group's label (`sourceGroupLabel`). Channel
   * labels omit the leading `#`: the row icon shows it. Thread titles stay intact.
   */
  name: string;
  /** Sessions in exactly this group. Zero for a parent that holds only subgroups. */
  own: SessionSectionCounts;
  /** This group and every subgroup: the counts of a folded row. */
  subtree: SessionSectionCounts;
  /** Newest activity in the subtree. Empty for a parent with no activity of its own. */
  lastActivityAt: string;
  children: GroupNode[];
  /** A `personal/<me>/` group whose path a `shared/` group also uses. The row shows a lock ("Only you"). */
  privateClash: boolean;
  /** A source group that is a direct message: the row shows a person, not a `#`. */
  dm?: boolean;
  /** A nested source thread group: the row shows a conversation icon. */
  thread?: boolean;
}

/** One source section (Slack, Telegram, Discord): its groups, read-only. */
export interface SourceSection {
  source: SessionSource;
  /** The groups below `shared/<source>/`, nested by `/`, newest first. */
  nodes: GroupNode[];
  /** Every session in the section. */
  counts: SessionSectionCounts;
}

/** Another person's `personal/<owner>/` groups that I can see (decision 4). */
export interface OwnerNode {
  ownerId: string;
  /** Flat, newest first. A group directly at `personal/<owner>/` has the name "". */
  groups: GroupNode[];
  subtree: SessionSectionCounts;
  lastActivityAt: string;
}

export interface SessionGroupTree {
  myGroups: GroupNode[];
  sharedWithMe: OwnerNode[];
  /** Sessions under My groups, for the section header. */
  myGroupsTotal: number;
  /** Sessions under Shared with me, for the section header. */
  sharedWithMeTotal: number;
  /** In `SESSION_SOURCES` order, only the sources with groups. */
  sources: SourceSection[];
}

const ZERO: SessionSectionCounts = { total: 0, unread: 0, running: 0, needsYou: 0 };

function addCounts(a: SessionSectionCounts, b: SessionSectionCounts): SessionSectionCounts {
  return {
    total: a.total + b.total,
    unread: a.unread + b.unread,
    running: a.running + b.running,
    needsYou: a.needsYou + b.needsYou,
  };
}

function segments(key: string): string[] {
  return key.split("/").filter(Boolean);
}

/** `shared/` and `personal/<me>/` hold sessions with no group (plan D4). */
export function isNoGroupKey(key: string, me: string | null): boolean {
  return key === "shared/" || (me !== null && key === `personal/${me}/`);
}

/** A root key's group: the key without a trailing `<kind>:<id>/` leaf (plan D4, the server's rule). */
export function groupKeyOf(key: string): string {
  return key.replace(/\/(?:task|thread|schedule|workflow):[^/]+\/$/, "/");
}

/**
 * A group name as one key segment: lower case, spaces to `-`, only
 * `a-z 0-9 . _ -`, at most 48 characters. No `:`, so a name never reads as a
 * `<kind>:<id>` leaf (plan D4).
 */
export function groupSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 48)
    .replace(/[-.]+$/, "");
}

/** The key of group `name` under `parent` (`shared/` or a group key), or null for an empty name. */
export function childGroupKey(parent: string, name: string): string | null {
  const slug = groupSlug(name);
  return slug ? `${parent}${slug}/` : null;
}

/** The key with its last segment renamed, or null for an empty name. */
export function renamedGroupKey(key: string, name: string): string | null {
  const parent = key.replace(/[^/]+\/$/, "");
  return childGroupKey(parent, name);
}

/** The key a session gets when it moves to No group (`null`): `shared/task:<rootId>/` (the server's default). */
export function defaultSessionKey(rootId: string): string {
  return `shared/task:${rootId}/`;
}

/**
 * What to send to put a session back on `key` (Undo after a move). `null`
 * gives back `shared/task:<rootId>/` only, so any other key goes as itself
 * (`personal/<me>/task:…`, `shared/schedule:…/`, a group).
 */
export function restoreKey(rootId: string, key: string): string | null {
  return key === defaultSessionKey(rootId) ? null : key;
}

/** Why a session or group write into `personal/…` fails on this connection. */
export const PERSONAL_WRITE_REASON = "Personal groups need a user token.";

/**
 * Why a write into `key` fails here, or null when it works. The server
 * takes writes into a `personal/` key only from a user token (`aswt_`), not
 * from the operator key with a picked user. Moving out of a personal group
 * and deleting one work on both. `null` (No group) never fails.
 */
export function groupWriteBlock(key: string | null, userToken: boolean): string | null {
  return !userToken && key?.startsWith("personal/") ? PERSONAL_WRITE_REASON : null;
}

/** The owner of a `personal/<owner>/...` key, or null for any other key. */
export function personalOwner(key: string): string | null {
  const parts = segments(key);
  return parts[0] === "personal" && parts[1] ? parts[1] : null;
}

/**
 * The namespace root of a My groups key: `shared/` or `personal/<me>/`. Null
 * for a key that belongs to another person or to no namespace.
 */
function myBase(key: string, me: string | null): string | null {
  if (key.startsWith("shared/")) return "shared/";
  if (me !== null && key.startsWith(`personal/${me}/`)) return `personal/${me}/`;
  return null;
}

/** A source as its section names it: `Slack`, `Telegram`, `Discord`. */
function sourceName(source: SessionSource): string {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

/**
 * The muted group label of a row in a flat list (Inbox, Later, Done): the
 * last segment, or a source group's label (`#eng`, `DM · Lena`).
 */
export function groupLabel(
  groupKey: string | undefined,
  me: string | null,
  labels: Readonly<Record<string, string>> = {},
): string {
  if (!groupKey || isNoGroupKey(groupKey, me)) return "";
  const source = sourceOfGroupKey(groupKey);
  if (source) return sourceGroupLabel(groupKey, labels) || sourceName(source);
  const owner = personalOwner(groupKey);
  const parts = segments(groupKey).slice(owner ? 2 : 1);
  return parts[parts.length - 1] ?? "";
}

/**
 * The group path for a hover card: `northwind › pricing`. A group of another
 * person starts with that person's name. A source group reads as its source
 * and its label (`Slack › #eng`). No group reads "No group".
 */
export function groupCrumb(
  groupKey: string | undefined,
  me: string | null,
  nameOf: (userId: string) => string,
  labels: Readonly<Record<string, string>> = {},
): string {
  if (!groupKey || isNoGroupKey(groupKey, me)) return "No group";
  const source = sourceOfGroupKey(groupKey);
  if (source) {
    const label = sourceGroupLabel(groupKey, labels);
    return label ? `${sourceName(source)} › ${label}` : sourceName(source);
  }
  const owner = personalOwner(groupKey);
  const parts = segments(groupKey).slice(owner ? 2 : 1);
  if (owner && owner !== me) return [nameOf(owner), ...parts].join(" › ");
  return parts.join(" › ");
}

/** The ids below `shared/<source>/`: `["c0ar967k0kz"]` for a Slack channel group. */
function sourceIds(key: string): string[] {
  return segments(key).slice(2);
}

function isThreadGroupKey(key: string): boolean {
  return sourceOfGroupKey(key) !== null && /\/thread:[^/]+\/$/.test(key);
}

/**
 * The name of a source group: its label from the tree (`#eng`, `DM · Lena`,
 * a Telegram chat title), else a name from its id: `#<ID>` for a Slack
 * channel (`c…`, `g…`, in Slack's upper case), `DM` for a Slack DM (`d…`),
 * `Thread · <id>` for a nested thread, and the raw id otherwise. A thread
 * label can be a prompt preview, so it reads as one title line, without
 * wrapper blocks or Slack tokens.
 */
export function sourceGroupLabel(
  key: string,
  labels: Readonly<Record<string, string>> = {},
): string {
  const label = labels[key];
  if (label) return (isThreadGroupKey(key) && promptTitle(label)) || label;
  const ids = sourceIds(key);
  const id = ids[ids.length - 1] ?? "";
  if (isThreadGroupKey(key)) return `Thread · ${id.slice("thread:".length)}`;
  if (sourceOfGroupKey(key) === "slack" && ids.length === 1) {
    if (/^[cg]/.test(id)) return `#${id.toUpperCase()}`;
    if (id.startsWith("d")) return "DM";
  }
  return id;
}

/**
 * A direct message: a Slack `d…` id, a Telegram private chat (a positive
 * chat id; groups are negative), or a `DM · <name>` label (Discord).
 */
function isSourceDm(key: string, labels: Readonly<Record<string, string>>): boolean {
  const ids = sourceIds(key);
  if (ids.length !== 1) return false;
  const source = sourceOfGroupKey(key);
  if (source === "slack" && ids[0].startsWith("d")) return true;
  if (source === "telegram" && !ids[0].startsWith("-")) return true;
  return labels[key]?.startsWith("DM · ") ?? false;
}

/** A group a session can move into or start in, with the path the sidebar shows. */
export interface GroupTarget {
  key: string;
  /** `northwind › pricing`. */
  label: string;
  /** A `personal/<me>/` group whose path a `shared/` group also uses: show the lock. */
  privateClash: boolean;
}

/**
 * My groups as one flat list (the move dialog, the Start in picker): every
 * group and every parent, `shared/` groups first, then my personal groups,
 * each by path. Shared with me is not a target (SPEC R3).
 */
export function groupTargets(groups: SessionGroupTree, me: string | null): GroupTarget[] {
  const targets: GroupTarget[] = [];
  const walk = (node: GroupNode) => {
    targets.push({
      key: node.key,
      label: groupCrumb(node.key, me, () => ""),
      privateClash: node.privateClash,
    });
    for (const child of node.children) walk(child);
  };
  for (const node of groups.myGroups) walk(node);
  return targets.sort((a, b) => {
    const personal = Number(a.key.startsWith("personal/")) - Number(b.key.startsWith("personal/"));
    return personal || a.label.localeCompare(b.label);
  });
}

/** Every group in the tree, other people's too, by path: what search can name with `in:`. */
export function searchableGroups(
  groups: SessionGroupTree,
  me: string | null,
  nameOf: (userId: string) => string,
): Array<{ key: string; label: string }> {
  const others = groups.sharedWithMe.flatMap((owner) =>
    owner.groups.map((node) => ({ key: node.key, label: groupCrumb(node.key, me, nameOf) })),
  );
  return [...groupTargets(groups, me), ...others];
}

/** Newest activity first, then by name, so the order holds still between polls. */
function byActivity(a: { lastActivityAt: string; name?: string }, b: typeof a): number {
  if (a.lastActivityAt !== b.lastActivityAt) return a.lastActivityAt < b.lastActivityAt ? 1 : -1;
  return (a.name ?? "").localeCompare(b.name ?? "");
}

/** Fill in `subtree` and `lastActivityAt` from the leaves up, and sort each level. */
function rollUp(node: GroupNode): void {
  let subtree = node.own;
  let last = node.lastActivityAt;
  for (const child of node.children) {
    rollUp(child);
    subtree = addCounts(subtree, child.subtree);
    if (child.lastActivityAt > last) last = child.lastActivityAt;
  }
  node.subtree = subtree;
  node.lastActivityAt = last;
  node.children.sort(byActivity);
}

/** Groups nested by `/` below their base (`shared/`, `shared/slack/`), with a parent node for every prefix. */
function nester() {
  const nodes = new Map<string, GroupNode>();
  const roots: GroupNode[] = [];
  const nodeFor = (key: string, base: string): GroupNode => {
    const found = nodes.get(key);
    if (found) return found;
    const parts = segments(key.slice(base.length));
    const node: GroupNode = {
      key,
      name: parts[parts.length - 1] ?? "",
      own: ZERO,
      subtree: ZERO,
      lastActivityAt: "",
      children: [],
      privateClash: false,
    };
    nodes.set(key, node);
    if (parts.length <= 1) roots.push(node);
    else nodeFor(`${base}${parts.slice(0, -1).join("/")}/`, base).children.push(node);
    return node;
  };
  return { nodes, roots, nodeFor };
}

/**
 * The sidebar tree. My groups holds `shared/` groups and my `personal/<me>/`
 * groups, nested by `/`, with a parent node for every prefix. Shared with me
 * holds other people's `personal/<owner>/` groups, one node per owner. Each
 * source (`shared/slack/`, `shared/telegram/`, `shared/discord/`) gets its
 * own section, named with `labels`, and stays out of My groups, so it is
 * never a move or Start in target. No group keys stay out: the No group box
 * shows them.
 *
 * `me` is null for an operator with no picked user. Then every personal group
 * belongs to another person.
 */
export function buildSessionGroupTree(
  groups: SessionTreeGroup[],
  me: string | null,
  labels: Readonly<Record<string, string>> = {},
): SessionGroupTree {
  const mine = nester();
  const { nodes, roots } = mine;
  const bySource = new Map<SessionSource, ReturnType<typeof nester>>();

  const owners = new Map<string, OwnerNode>();
  for (const group of groups) {
    if (isNoGroupKey(group.key, me)) continue;
    const counts: SessionSectionCounts = {
      total: group.total,
      unread: group.unread,
      running: group.running,
      needsYou: group.needsYou,
    };
    const source = sourceOfGroupKey(group.key);
    const base = source ? `shared/${source}/` : myBase(group.key, me);
    if (base) {
      let tree = mine;
      if (source) {
        tree = bySource.get(source) ?? nester();
        bySource.set(source, tree);
      }
      const node = tree.nodeFor(group.key, base);
      node.own = counts;
      node.lastActivityAt = group.lastActivityAt;
      continue;
    }
    const ownerId = personalOwner(group.key);
    if (!ownerId) continue;
    let owner = owners.get(ownerId);
    if (!owner) {
      owner = { ownerId, groups: [], subtree: ZERO, lastActivityAt: "" };
      owners.set(ownerId, owner);
    }
    owner.groups.push({
      key: group.key,
      name: segments(group.key).slice(2).join(" › "),
      own: counts,
      subtree: counts,
      lastActivityAt: group.lastActivityAt,
      children: [],
      privateClash: false,
    });
    owner.subtree = addCounts(owner.subtree, counts);
    if (group.lastActivityAt > owner.lastActivityAt) owner.lastActivityAt = group.lastActivityAt;
  }

  for (const root of roots) rollUp(root);
  roots.sort(byActivity);
  // A personal group shows by name, like a shared one (SPEC R5). Only a name
  // clash with a shared group gets the lock.
  if (me !== null) {
    const personalBase = `personal/${me}/`;
    for (const node of nodes.values()) {
      if (!node.key.startsWith(personalBase)) continue;
      node.privateClash = nodes.has(`shared/${node.key.slice(personalBase.length)}`);
    }
  }

  const sharedWithMe = [...owners.values()].sort(byActivity);
  for (const owner of sharedWithMe) owner.groups.sort(byActivity);

  const sources = SESSION_SOURCES.flatMap((source): SourceSection[] => {
    const tree = bySource.get(source);
    if (!tree) return [];
    // Names first: the roll-up sorts by them. A channel row's `#` icon
    // already says channel, so `#eng` shows as `eng`, like a user group.
    for (const node of tree.nodes.values()) {
      const label = sourceGroupLabel(node.key, labels);
      node.thread = isThreadGroupKey(node.key);
      node.dm = isSourceDm(node.key, labels);
      node.name = node.dm || node.thread ? label : label.replace(/^#/, "");
    }
    for (const root of tree.roots) rollUp(root);
    tree.roots.sort(byActivity);
    const counts = tree.roots.reduce((sum, node) => addCounts(sum, node.subtree), ZERO);
    return [{ source, nodes: tree.roots, counts }];
  });

  return {
    myGroups: roots,
    sharedWithMe,
    myGroupsTotal: roots.reduce((sum, node) => sum + node.subtree.total, 0),
    sharedWithMeTotal: sharedWithMe.reduce((sum, owner) => sum + owner.subtree.total, 0),
    sources,
  };
}
