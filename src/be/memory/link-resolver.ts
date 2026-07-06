/**
 * Deterministic link resolver for memory content.
 *
 * Scans memory content for recognizable patterns (wikilinks, agent-fs paths,
 * PR references, agent-UI URLs) and resolves them to typed `memory_link` rows.
 * Phase 1: capture layer only — no traversal tools, no reranker integration.
 */
import { getDb } from "@/be/db";

export type LinkType =
  | "wikilink"
  | "sequel"
  | "agent-fs-file"
  | "agent-ui"
  | "pr"
  | "external-source";
export type TargetKind = "memory" | "agent-fs-file" | "agent-ui" | "pr" | "external-source";

export interface ResolvedLink {
  linkType: LinkType;
  targetKind: TargetKind;
  targetId: string;
  strength: number;
  resolver: string;
  sourceText: string;
  metadata?: Record<string, unknown>;
}

interface MatcherResult {
  linkType: LinkType;
  targetKind: TargetKind;
  targetId: string;
  sourceText: string;
  resolver: string;
  metadata?: Record<string, unknown>;
}

type Matcher = (content: string) => MatcherResult[];

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
const PR_HASH_RE = /(?:^|[\s(])#(\d{1,5})(?=[\s,.)!?]|$)/gm;
const PR_PREFIX_RE = /\bPR\s*#(\d{1,5})\b/gi;
const GITHUB_PR_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
const AGENT_FS_PATH_RE =
  /(?:agent-fs|live\.agent-fs\.dev)\/file\/~\/([a-f0-9-]+)\/([a-f0-9-]+)\/([\w/.%-]+)/g;
const AGENT_UI_PAGE_RE = /(?:app\.[^/]+|localhost:\d+)\/pages\/([a-f0-9-]+)/g;
const AGENT_UI_TASK_RE = /(?:app\.[^/]+|localhost:\d+)\/tasks\/([a-f0-9-]+)/g;

const wikilinkMatcher: Matcher = (content) => {
  const results: MatcherResult[] = [];
  for (const match of content.matchAll(WIKILINK_RE)) {
    const name = match[1]!.trim();
    if (!name) continue;
    results.push({
      linkType: "wikilink",
      targetKind: "memory",
      targetId: name,
      sourceText: match[0],
      resolver: "wikilink",
    });
  }
  return results;
};

const prMatcher: Matcher = (content) => {
  const results: MatcherResult[] = [];
  const seen = new Set<string>();

  for (const match of content.matchAll(GITHUB_PR_URL_RE)) {
    const id = `github:${match[1]}/${match[2]}#${match[3]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({
      linkType: "pr",
      targetKind: "pr",
      targetId: id,
      sourceText: match[0],
      resolver: "pr-url",
      metadata: { owner: match[1], repo: match[2], number: Number(match[3]) },
    });
  }

  for (const match of content.matchAll(PR_PREFIX_RE)) {
    const id = `pr:${match[1]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({
      linkType: "pr",
      targetKind: "pr",
      targetId: id,
      sourceText: match[0].trim(),
      resolver: "pr-prefix",
      metadata: { number: Number(match[1]) },
    });
  }

  for (const match of content.matchAll(PR_HASH_RE)) {
    const id = `pr:${match[1]}`;
    if (seen.has(id)) continue;
    seen.add(id);
    results.push({
      linkType: "pr",
      targetKind: "pr",
      targetId: id,
      sourceText: `#${match[1]}`,
      resolver: "pr-hash",
      metadata: { number: Number(match[1]) },
    });
  }

  return results;
};

const agentFsMatcher: Matcher = (content) => {
  const results: MatcherResult[] = [];
  for (const match of content.matchAll(AGENT_FS_PATH_RE)) {
    const orgId = match[1]!;
    const driveId = match[2]!;
    const path = match[3]!;
    results.push({
      linkType: "agent-fs-file",
      targetKind: "agent-fs-file",
      targetId: `${orgId}/${driveId}/${path}`,
      sourceText: match[0],
      resolver: "agent-fs-path",
      metadata: { orgId, driveId, path },
    });
  }
  return results;
};

const agentUiMatcher: Matcher = (content) => {
  const results: MatcherResult[] = [];
  for (const match of content.matchAll(AGENT_UI_PAGE_RE)) {
    results.push({
      linkType: "agent-ui",
      targetKind: "agent-ui",
      targetId: `page:${match[1]}`,
      sourceText: match[0],
      resolver: "agent-ui-page",
    });
  }
  for (const match of content.matchAll(AGENT_UI_TASK_RE)) {
    results.push({
      linkType: "agent-ui",
      targetKind: "agent-ui",
      targetId: `task:${match[1]}`,
      sourceText: match[0],
      resolver: "agent-ui-task",
    });
  }
  return results;
};

const MATCHERS: Matcher[] = [wikilinkMatcher, prMatcher, agentFsMatcher, agentUiMatcher];

export function resolveLinks(content: string): ResolvedLink[] {
  const results: ResolvedLink[] = [];
  for (const matcher of MATCHERS) {
    for (const link of matcher(content)) {
      results.push({ ...link, strength: 1.0 });
    }
  }
  return results;
}

export function resolveWikilinksToMemoryIds(
  agentId: string,
  links: ResolvedLink[],
): ResolvedLink[] {
  const db = getDb();
  const findByName = db.prepare<{ id: string }, [string, string]>(
    "SELECT id FROM agent_memory WHERE name = ? AND (agentId = ? OR scope = 'swarm') LIMIT 1",
  );

  return links.map((link) => {
    if (link.linkType !== "wikilink") return link;
    const row = findByName.get(link.targetId, agentId);
    if (row) {
      return { ...link, targetId: row.id };
    }
    return link;
  });
}

const INSERT_LINK_SQL = `INSERT OR IGNORE INTO memory_link
   (id, from_memory_id, linkType, targetKind, targetId, strength, resolver, sourceText, metadata, createdAt, updatedAt)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertLinkArgs(
  memoryId: string,
  link: ResolvedLink,
  now: string,
): [string, string, string, string, string, number, string, string, string | null, string, string] {
  return [
    crypto.randomUUID(),
    memoryId,
    link.linkType,
    link.targetKind,
    link.targetId,
    link.strength,
    link.resolver,
    link.sourceText,
    link.metadata ? JSON.stringify(link.metadata) : null,
    now,
    now,
  ];
}

export function storeLinks(memoryId: string, agentId: string, content: string): void {
  const links = resolveLinks(content);
  if (links.length === 0) return;

  const resolved = resolveWikilinksToMemoryIds(agentId, links);
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(INSERT_LINK_SQL);

  db.transaction(() => {
    for (const link of resolved) {
      insert.run(...insertLinkArgs(memoryId, link, now));
    }
  })();
}

/** The `memory_link` UNIQUE-constraint identity — the natural diff key for pruning. */
function linkIdentity(link: {
  linkType: string;
  targetKind: string;
  targetId: string;
  sourceText: string | null;
}): string {
  return JSON.stringify([link.linkType, link.targetKind, link.targetId, link.sourceText ?? null]);
}

/**
 * Re-derive content links on the EDIT/RE-INDEX paths (DES-639b).
 *
 * Unlike the additive `storeLinks`, this prunes: in one transaction it
 * deletes content-derived rows (`linkType != 'sequel'`) whose UNIQUE identity
 * (linkType, targetKind, targetId, sourceText) is absent from the new
 * content's resolved set, then INSERT OR IGNOREs the new set. `sequel` links
 * are preserved — they are created by `storeSequelLink` (resolver
 * 'sequel-auto') and are not derivable from content. Fresh-store paths keep
 * plain `storeLinks`.
 */
export function refreshLinks(memoryId: string, agentId: string, content: string): void {
  const resolved = resolveWikilinksToMemoryIds(agentId, resolveLinks(content));
  const nextIdentities = new Set(resolved.map((link) => linkIdentity(link)));

  const db = getDb();
  const now = new Date().toISOString();
  const selectExisting = db.prepare<
    {
      id: string;
      linkType: string;
      targetKind: string;
      targetId: string;
      sourceText: string | null;
    },
    [string]
  >(
    `SELECT id, linkType, targetKind, targetId, sourceText
       FROM memory_link
      WHERE from_memory_id = ? AND linkType != 'sequel'`,
  );
  const deleteById = db.prepare("DELETE FROM memory_link WHERE id = ?");
  const insert = db.prepare(INSERT_LINK_SQL);

  db.transaction(() => {
    for (const row of selectExisting.all(memoryId)) {
      if (!nextIdentities.has(linkIdentity(row))) {
        deleteById.run(row.id);
      }
    }
    for (const link of resolved) {
      insert.run(...insertLinkArgs(memoryId, link, now));
    }
  })();
}

export function storeSequelLink(fromMemoryId: string, toMemoryId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO memory_link
       (id, from_memory_id, linkType, targetKind, targetId, strength, resolver, sourceText, metadata, createdAt, updatedAt)
     VALUES (?, ?, 'sequel', 'memory', ?, 1.0, 'sequel-auto', NULL, NULL, ?, ?)`,
  ).run(crypto.randomUUID(), fromMemoryId, toMemoryId, now, now);
}
