import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, createAgent, getDb, initDb } from "../be/db";
import {
  refreshLinks,
  resolveLinks,
  storeLinks,
  storeSequelLink,
} from "../be/memory/link-resolver";
import { getLinksForMemory } from "../be/memory/links-store";
import { SqliteMemoryStore } from "../be/memory/providers/sqlite-store";

describe("resolveLinks", () => {
  test("extracts wikilinks from content", () => {
    const links = resolveLinks("See [[auth-fix-pattern]] and [[pr585-codex-binary]] for context.");
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({
      linkType: "wikilink",
      targetKind: "memory",
      targetId: "auth-fix-pattern",
      resolver: "wikilink",
    });
    expect(links[1]).toMatchObject({
      linkType: "wikilink",
      targetKind: "memory",
      targetId: "pr585-codex-binary",
      resolver: "wikilink",
    });
  });

  test("extracts PR references with hash notation", () => {
    const links = resolveLinks("Fixed in #696 and PR #470.");
    const prLinks = links.filter((l) => l.linkType === "pr");
    expect(prLinks.length).toBeGreaterThanOrEqual(2);
    const ids = prLinks.map((l) => l.targetId);
    expect(ids).toContain("pr:696");
    expect(ids).toContain("pr:470");
  });

  test("extracts full GitHub PR URLs", () => {
    const links = resolveLinks(
      "See https://github.com/desplega-ai/agent-swarm/pull/763 for the fix.",
    );
    const prLinks = links.filter((l) => l.linkType === "pr");
    expect(prLinks).toHaveLength(1);
    expect(prLinks[0]).toMatchObject({
      linkType: "pr",
      targetKind: "pr",
      targetId: "github:desplega-ai/agent-swarm#763",
      resolver: "pr-url",
    });
  });

  test("extracts agent-fs paths", () => {
    const links = resolveLinks(
      "Plan at live.agent-fs.dev/file/~/648a5f3c-35c8-4f11-8673-b89de52cd6bd/2faf73ba-4eee-4472-8b3b-359c4ed6bfbb/thoughts/plan.md",
    );
    const fsLinks = links.filter((l) => l.linkType === "agent-fs-file");
    expect(fsLinks).toHaveLength(1);
    expect(fsLinks[0]!.targetKind).toBe("agent-fs-file");
    expect(fsLinks[0]!.resolver).toBe("agent-fs-path");
  });

  test("extracts agent-ui page links", () => {
    const links = resolveLinks(
      "See app.agent-swarm.dev/pages/abc12345-1234-1234-1234-123456789abc",
    );
    const uiLinks = links.filter((l) => l.linkType === "agent-ui");
    expect(uiLinks).toHaveLength(1);
    expect(uiLinks[0]).toMatchObject({
      targetKind: "agent-ui",
      targetId: "page:abc12345-1234-1234-1234-123456789abc",
      resolver: "agent-ui-page",
    });
  });

  test("deduplicates PR references", () => {
    const links = resolveLinks("PR #696, see also PR #696 again, and #696 once more.");
    const prLinks = links.filter((l) => l.linkType === "pr");
    const ids696 = prLinks.filter((l) => l.targetId === "pr:696");
    expect(ids696).toHaveLength(1);
  });

  test("returns empty array for content without links", () => {
    const links = resolveLinks("This is plain text with no links or references.");
    expect(links).toHaveLength(0);
  });

  test("handles mixed content with multiple link types", () => {
    const content = `
      See [[memory-search-fix]] for context.
      PR #696 fixed the embedding issue.
      Plan: live.agent-fs.dev/file/~/648a5f3c-35c8-4f11-8673-b89de52cd6bd/2faf73ba/thoughts/plan.md
    `;
    const links = resolveLinks(content);
    const types = new Set(links.map((l) => l.linkType));
    expect(types.has("wikilink")).toBe(true);
    expect(types.has("pr")).toBe(true);
    expect(types.has("agent-fs-file")).toBe(true);
  });
});

// ─── DB-write surface + traversal reads (DES-639b) ──────────────────────────

const TEST_DB_PATH = "./test-memory-link-resolver.sqlite";
const agentX = "aaaa0000-0000-4000-8000-000000000301";
const agentY = "bbbb0000-0000-4000-8000-000000000302";

type LinkRow = {
  id: string;
  linkType: string;
  targetKind: string;
  targetId: string;
  sourceText: string | null;
};

function linkRowsFor(memoryId: string): LinkRow[] {
  return getDb()
    .prepare<LinkRow, [string]>(
      `SELECT id, linkType, targetKind, targetId, sourceText
         FROM memory_link WHERE from_memory_id = ? ORDER BY linkType, targetId`,
    )
    .all(memoryId);
}

describe("memory_link DB surface", () => {
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
    initDb(TEST_DB_PATH);
    createAgent({ id: agentX, name: "Link Agent X", isLead: false, status: "idle" });
    createAgent({ id: agentY, name: "Link Agent Y", isLead: false, status: "idle" });
    store = new SqliteMemoryStore();
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {}
    }
  });

  beforeEach(() => {
    getDb().run("DELETE FROM memory_link");
    getDb().run("DELETE FROM agent_memory");
  });

  function seed(name: string, content: string, opts: { agentId?: string; scope?: string } = {}) {
    return store.store({
      agentId: opts.agentId ?? agentX,
      scope: (opts.scope ?? "agent") as "agent" | "swarm",
      name,
      content,
      source: "manual",
    });
  }

  test("storeLinks persists rows and resolves wikilinks to memory ids", () => {
    const b = seed("b-target", "target memory B");
    const a = seed("a-source", "See [[b-target]] and PR #123 for details.");

    storeLinks(a.id, agentX, a.content);

    const rows = linkRowsFor(a.id);
    const wikilink = rows.find((r) => r.linkType === "wikilink");
    const pr = rows.find((r) => r.linkType === "pr");
    expect(wikilink?.targetId).toBe(b.id);
    expect(wikilink?.targetKind).toBe("memory");
    expect(pr?.targetId).toBe("pr:123");
  });

  test("refreshLinks drops removed links, keeps surviving and sequel links", () => {
    const b = seed("b-target", "target memory B");
    const c = seed("c-target", "target memory C");
    const a = seed("a-source", "See [[b-target]] and [[c-target]], fixed in #77.");

    storeLinks(a.id, agentX, a.content);
    storeSequelLink(a.id, b.id);
    expect(linkRowsFor(a.id)).toHaveLength(4);
    const survivorId = linkRowsFor(a.id).find(
      (r) => r.linkType === "wikilink" && r.targetId === b.id,
    )?.id;

    refreshLinks(a.id, agentX, "See [[b-target]] only now.");

    const rows = linkRowsFor(a.id);
    expect(rows).toHaveLength(2);
    const wikilink = rows.find((r) => r.linkType === "wikilink");
    expect(wikilink?.targetId).toBe(b.id);
    // Surviving row is kept, not recreated (INSERT OR IGNORE hits the UNIQUE key).
    expect(wikilink?.id).toBe(survivorId!);
    expect(rows.find((r) => r.linkType === "sequel")?.targetId).toBe(b.id);
    expect(rows.some((r) => r.targetId === c.id)).toBe(false);
    expect(rows.some((r) => r.targetId === "pr:77")).toBe(false);
  });

  test("refreshLinks with linkless content clears all content-derived links", () => {
    const b = seed("b-target", "target memory B");
    const a = seed("a-source", "See [[b-target]] and #42.");
    storeLinks(a.id, agentX, a.content);
    storeSequelLink(a.id, b.id);

    refreshLinks(a.id, agentX, "Plain text without any references.");

    const rows = linkRowsFor(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.linkType).toBe("sequel");
  });

  test("getLinksForMemory returns outgoing links and backlinks", () => {
    const b = seed("b-target", "target memory B", { scope: "swarm" });
    const a = seed("a-source", "See [[b-target]].");
    storeLinks(a.id, agentX, a.content);

    const forA = getLinksForMemory(a.id, { viewerAgentId: agentX });
    expect(forA.links).toHaveLength(1);
    expect(forA.links[0]).toMatchObject({
      linkType: "wikilink",
      targetId: b.id,
      resolved: true,
      target: { id: b.id, name: "b-target", scope: "swarm" },
    });
    expect(forA.backlinks).toHaveLength(0);

    const forB = getLinksForMemory(b.id, { viewerAgentId: agentX });
    expect(forB.links).toHaveLength(0);
    expect(forB.backlinks).toHaveLength(1);
    expect(forB.backlinks[0]?.from).toEqual({ id: a.id, name: "a-source", scope: "agent" });
  });

  test("unresolved wikilinks come back with resolved: false and no target", () => {
    const a = seed("a-source", "See [[never-created-memory]].");
    storeLinks(a.id, agentX, a.content);

    const { links } = getLinksForMemory(a.id, { viewerAgentId: agentX });
    expect(links).toHaveLength(1);
    expect(links[0]?.resolved).toBe(false);
    expect(links[0]?.target).toBeUndefined();
    expect(links[0]?.targetId).toBe("never-created-memory");
  });

  test("non-memory link kinds are always resolved", () => {
    const a = seed("a-source", "Fixed in #123.");
    storeLinks(a.id, agentX, a.content);

    const { links } = getLinksForMemory(a.id, { viewerAgentId: agentX });
    expect(links).toHaveLength(1);
    expect(links[0]?.linkType).toBe("pr");
    expect(links[0]?.resolved).toBe(true);
    expect(links[0]?.target).toBeUndefined();
  });

  test("cross-agent agent-scoped backlink is not leaked to other agents", () => {
    const b = seed("b-target", "shared memory B", { scope: "swarm" });
    const yMem = seed("y-source", "Private note about [[b-target]].", { agentId: agentY });
    storeLinks(yMem.id, agentY, yMem.content);

    // agentX must not learn about agentY's private memory.
    expect(getLinksForMemory(b.id, { viewerAgentId: agentX }).backlinks).toHaveLength(0);
    // The owner sees it.
    const forOwner = getLinksForMemory(b.id, { viewerAgentId: agentY }).backlinks;
    expect(forOwner).toHaveLength(1);
    expect(forOwner[0]?.from.id).toBe(yMem.id);
    // Leads see all.
    expect(getLinksForMemory(b.id, { viewerAgentId: agentX, isLead: true }).backlinks).toHaveLength(
      1,
    );
  });

  test("agent-scoped link target metadata is hidden from other agents", () => {
    const priv = seed("x-private", "agent X private target");
    const a = seed("a-shared", "See [[x-private]].", { scope: "swarm" });
    storeLinks(a.id, agentX, a.content);

    const forOwner = getLinksForMemory(a.id, { viewerAgentId: agentX }).links;
    expect(forOwner[0]?.resolved).toBe(true);
    expect(forOwner[0]?.target?.id).toBe(priv.id);

    // Other agents see the link row but no target metadata — indistinguishable
    // from an unresolved link, so nothing leaks.
    const forOther = getLinksForMemory(a.id, { viewerAgentId: agentY }).links;
    expect(forOther[0]?.resolved).toBe(false);
    expect(forOther[0]?.target).toBeUndefined();
    // The resolved UUID must be redacted to the unresolved-row form (the
    // wikilink name) so private memory ids don't leak.
    expect(forOther[0]?.targetId).toBe("x-private");
    expect(forOther[0]?.targetId).not.toBe(priv.id);

    // Leads see all.
    const forLead = getLinksForMemory(a.id, { viewerAgentId: agentY, isLead: true }).links;
    expect(forLead[0]?.resolved).toBe(true);
    expect(forLead[0]?.target?.id).toBe(priv.id);
  });

  test("dangling links pointing at deleted memories are tolerated", () => {
    const b = seed("b-target", "target memory B");
    const a = seed("a-source", "See [[b-target]].");
    storeLinks(a.id, agentX, a.content);
    store.delete(b.id);

    const { links, backlinks } = getLinksForMemory(a.id, { viewerAgentId: agentX });
    expect(links).toHaveLength(1);
    expect(links[0]?.resolved).toBe(false);
    expect(links[0]?.target).toBeUndefined();
    // The once-resolved UUID of the deleted target must be redacted to the
    // wikilink-name form — same as hidden and unresolved rows.
    expect(links[0]?.targetId).toBe("b-target");
    expect(links[0]?.targetId).not.toBe(b.id);
    expect(backlinks).toHaveLength(0);
  });
});
