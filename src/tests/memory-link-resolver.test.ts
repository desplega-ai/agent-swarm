import { describe, expect, test } from "bun:test";
import { resolveLinks } from "../be/memory/link-resolver";

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
