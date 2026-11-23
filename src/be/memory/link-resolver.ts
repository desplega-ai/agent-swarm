/**
 * Deterministic link resolver for memory content.
 *
 * Scans memory content for recognizable patterns (wikilinks, agent-fs paths,
 * PR references, agent-UI URLs) and resolves them to typed `memory_link` rows.
 * Phase 1: capture layer only — no traversal tools, no reranker integration.
 */
import type { NewMemoryLink } from "@desplega/storage";
import { getStorage } from "@/be/storage";
import { getConfiguredAppUrls } from "@/utils/constants";

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
const AGENT_FS_LIVE_HOSTS = String.raw`agent-fs|live\.agent-fs\.dev`;
const AGENT_FS_FILE_ROUTE = String.raw`\/file\/~\/([a-f0-9-]+)\/([a-f0-9-]+)\/([\w/.%-]+)`;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * agent-fs file links: the live UI, and the dashboard (Comb) at a configured
 * `APP_URL` / `DASHBOARD_URL` or `localhost:<port>`. Both use the same
 * `/file/~/<org>/<drive>/<path>` route and path encoding, so they resolve to
 * the same target. Built per call: a config reload can change the app URLs.
 * A host must start the host name (`evil-swarm.example.com` does not match
 * `swarm.example.com`). Hosts are case-insensitive.
 */
function agentFsPathRegex(): RegExp {
  const appHosts = getConfiguredAppUrls().flatMap((value) => {
    try {
      const url = new URL(value);
      return [escapeRegExp(`${url.host}${url.pathname.replace(/\/+$/, "")}`)];
    } catch {
      return [];
    }
  });
  const hosts = [AGENT_FS_LIVE_HOSTS, ...appHosts, String.raw`localhost:\d+`].join("|");
  return new RegExp(`(?<![\\w.-])(?:${hosts})${AGENT_FS_FILE_ROUTE}`, "gi");
}

const agentFsMatcher: Matcher = (content) => {
  const results: MatcherResult[] = [];
  for (const match of content.matchAll(agentFsPathRegex())) {
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

export async function resolveWikilinksToMemoryIds(
  agentId: string,
  links: ResolvedLink[],
): Promise<ResolvedLink[]> {
  const repo = getStorage().repos.memory;
  const resolved: ResolvedLink[] = [];

  for (const link of links) {
    if (link.linkType !== "wikilink") {
      resolved.push(link);
      continue;
    }
    const id = await repo.findIdByNameVisible(link.targetId, agentId);
    resolved.push(id ? { ...link, targetId: id } : link);
  }

  return resolved;
}

function newLink(memoryId: string, link: ResolvedLink, now: string): NewMemoryLink {
  return {
    id: crypto.randomUUID(),
    fromMemoryId: memoryId,
    linkType: link.linkType,
    targetKind: link.targetKind,
    targetId: link.targetId,
    strength: link.strength,
    resolver: link.resolver,
    sourceText: link.sourceText,
    metadata: link.metadata ? JSON.stringify(link.metadata) : null,
    now,
  };
}

export async function storeLinks(
  memoryId: string,
  agentId: string,
  content: string,
): Promise<void> {
  const links = resolveLinks(content);
  if (links.length === 0) return;

  const resolved = await resolveWikilinksToMemoryIds(agentId, links);
  const now = new Date().toISOString();

  const storage = getStorage();
  await storage.transaction(async () => {
    for (const link of resolved) {
      await storage.repos.memory.insertLinkIfAbsent(newLink(memoryId, link, now));
    }
  });
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
export async function refreshLinks(
  memoryId: string,
  agentId: string,
  content: string,
): Promise<void> {
  const resolved = await resolveWikilinksToMemoryIds(agentId, resolveLinks(content));
  const nextIdentities = new Set(resolved.map((link) => linkIdentity(link)));

  const now = new Date().toISOString();

  const storage = getStorage();
  const repo = storage.repos.memory;
  await storage.transaction(async () => {
    const existing = await repo.listContentLinks(memoryId);
    for (const row of existing) {
      if (!nextIdentities.has(linkIdentity(row))) {
        await repo.deleteLink(row.id);
      }
    }
    for (const link of resolved) {
      await repo.insertLinkIfAbsent(newLink(memoryId, link, now));
    }
  });
}

export async function storeSequelLink(fromMemoryId: string, toMemoryId: string): Promise<void> {
  const now = new Date().toISOString();
  await getStorage().repos.memory.insertLinkIfAbsent({
    id: crypto.randomUUID(),
    fromMemoryId,
    linkType: "sequel",
    targetKind: "memory",
    targetId: toMemoryId,
    strength: 1.0,
    resolver: "sequel-auto",
    sourceText: null,
    metadata: null,
    now,
  });
}
