/**
 * Read-side query helpers for the `memory_link` table (DES-639b).
 *
 * The write path lives in `src/be/memory/link-resolver.ts` (`storeLinks` /
 * `refreshLinks` / `storeSequelLink`). This module surfaces traversal reads
 * to the memory-get surfaces (`GET /api/memory/{id}` and the `memory-get`
 * MCP tool): outgoing links plus inbound `targetKind='memory'` rows as a
 * `backlinks` array (same table, cheap).
 *
 * Visibility mirrors the search ACL (see `graph-expansion.ts`): non-lead
 * viewers see own-agent + swarm-scoped linked memories; leads see all.
 * `memory_link.targetId` has no FK — dangling rows (target deleted, or a
 * wikilink that never resolved past its raw name text) come back with
 * `resolved: false` and no target metadata, indistinguishable from targets
 * the viewer may not see, so nothing leaks. Server-side only.
 */
import { getDb } from "@/be/db";
import type { LinkType, TargetKind } from "./link-resolver";

/** Minimal metadata about a linked/backlinking memory — enough to memory-get it. */
export interface LinkedMemoryRef {
  id: string;
  name: string;
  scope: string;
}

export interface MemoryLinkView {
  id: string;
  linkType: LinkType;
  targetKind: TargetKind;
  targetId: string;
  strength: number;
  resolver: string;
  sourceText: string | null;
  createdAt: string;
  /**
   * For `targetKind='memory'`: true when targetId points at a live memory the
   * viewer may see. Non-memory kinds (pr, agent-fs-file, …) are always true —
   * their targetId is already the resolved external identity.
   */
  resolved: boolean;
  /** Present only when `resolved` and `targetKind='memory'`. */
  target?: LinkedMemoryRef;
}

export interface MemoryBacklinkView {
  id: string;
  linkType: LinkType;
  strength: number;
  sourceText: string | null;
  createdAt: string;
  /** The memory whose content links here. Always visible to the viewer (ACL-filtered). */
  from: LinkedMemoryRef;
}

export interface MemoryLinksResult {
  links: MemoryLinkView[];
  backlinks: MemoryBacklinkView[];
}

export interface GetLinksOptions {
  /** The requesting agent; undefined = anonymous (swarm-scoped visibility only). */
  viewerAgentId?: string;
  /** Leads see all linked-memory metadata regardless of scope. Default false. */
  isLead?: boolean;
}

type OutgoingRow = {
  id: string;
  linkType: LinkType;
  targetKind: TargetKind;
  targetId: string;
  strength: number;
  resolver: string;
  sourceText: string | null;
  createdAt: string;
  targetMemoryId: string | null;
  targetName: string | null;
  targetScope: string | null;
  targetAgentId: string | null;
};

type BacklinkRow = {
  id: string;
  linkType: LinkType;
  strength: number;
  sourceText: string | null;
  createdAt: string;
  fromId: string;
  fromName: string;
  fromScope: string;
};

/** Hidden-target redaction: `[[Name]]` sourceText → `Name` (the unresolved-row form); anything else → "". */
function redactedTargetId(sourceText: string | null): string {
  const wikilink = /^\[\[(.+)\]\]$/.exec(sourceText ?? "");
  return wikilink?.[1] ?? "";
}

export function getLinksForMemory(
  memoryId: string,
  options: GetLinksOptions = {},
): MemoryLinksResult {
  const { viewerAgentId, isLead = false } = options;
  const db = getDb();

  // Outgoing links. The LEFT JOIN resolves memory-kind targets to a live
  // agent_memory row; dangling/unresolved/expired targets join to NULL.
  const outgoing = db
    .prepare<OutgoingRow, [string]>(
      `SELECT ml.id, ml.linkType, ml.targetKind, ml.targetId, ml.strength,
              ml.resolver, ml.sourceText, ml.createdAt,
              m.id AS targetMemoryId, m.name AS targetName,
              m.scope AS targetScope, m.agentId AS targetAgentId
         FROM memory_link ml
         LEFT JOIN agent_memory m
           ON ml.targetKind = 'memory'
          AND m.id = ml.targetId
          AND (m.expiresAt IS NULL OR m.expiresAt > datetime('now'))
        WHERE ml.from_memory_id = ?
        ORDER BY ml.createdAt ASC, ml.id ASC`,
    )
    .all(memoryId);

  const links: MemoryLinkView[] = outgoing.map((row) => {
    if (row.targetKind !== "memory") {
      return {
        id: row.id,
        linkType: row.linkType,
        targetKind: row.targetKind,
        targetId: row.targetId,
        strength: row.strength,
        resolver: row.resolver,
        sourceText: row.sourceText,
        createdAt: row.createdAt,
        resolved: true,
      };
    }
    const live = row.targetMemoryId !== null;
    const visible =
      live &&
      (isLead || row.targetScope === "swarm" || (row.targetAgentId ?? "") === viewerAgentId);
    // Redact targetId for live-but-ACL-hidden targets: exposing the resolved
    // UUID would leak private memory ids AND let a viewer tell a hidden target
    // apart from an unresolved wikilink. Redact to the wikilink NAME (derived
    // from sourceText, verbatim content of the from-memory the viewer already
    // reads) — the exact form an unresolved row stores in targetId. Unresolved
    // and dangling rows keep their stored value.
    const base: MemoryLinkView = {
      id: row.id,
      linkType: row.linkType,
      targetKind: row.targetKind,
      targetId: visible || !live ? row.targetId : redactedTargetId(row.sourceText),
      strength: row.strength,
      resolver: row.resolver,
      sourceText: row.sourceText,
      createdAt: row.createdAt,
      resolved: false,
    };
    if (!visible) return base;
    return {
      ...base,
      resolved: true,
      target: {
        id: row.targetMemoryId as string,
        name: row.targetName ?? "",
        scope: row.targetScope ?? "",
      },
    };
  });

  // Inbound links (backlinks): rows in the same table pointing at this memory.
  // INNER JOIN drops rows whose source memory no longer exists; the scope
  // condition keeps cross-agent agent-scoped sources invisible to non-leads.
  const conditions = [
    "ml.targetKind = 'memory'",
    "ml.targetId = ?",
    "(m.expiresAt IS NULL OR m.expiresAt > datetime('now'))",
  ];
  const params: (string | null)[] = [memoryId];
  if (!isLead) {
    conditions.push("(m.agentId = ? OR m.scope = 'swarm')");
    params.push(viewerAgentId ?? null);
  }

  const inbound = db
    .prepare<BacklinkRow, (string | null)[]>(
      `SELECT ml.id, ml.linkType, ml.strength, ml.sourceText, ml.createdAt,
              m.id AS fromId, m.name AS fromName, m.scope AS fromScope
         FROM memory_link ml
         JOIN agent_memory m ON m.id = ml.from_memory_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY ml.createdAt ASC, ml.id ASC`,
    )
    .all(...params);

  const backlinks: MemoryBacklinkView[] = inbound.map((row) => ({
    id: row.id,
    linkType: row.linkType,
    strength: row.strength,
    sourceText: row.sourceText,
    createdAt: row.createdAt,
    from: { id: row.fromId, name: row.fromName, scope: row.fromScope },
  }));

  return { links, backlinks };
}
