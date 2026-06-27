import { describe, expect, test } from "bun:test";
import { buildClaudeAliasMap, resolveClaudeAlias } from "./model-alias.ts";
import { getClaudeAliasMap, lookupModelCost } from "./pricing.ts";

describe("buildClaudeAliasMap (frozen rule, synthetic fixtures)", () => {
  test("picks the max release_date per family, excluding dated and -latest ids", () => {
    const map = buildClaudeAliasMap([
      { id: "claude-opus-4-7", releaseDate: "2026-04-16" },
      { id: "claude-opus-4-8", releaseDate: "2026-05-28" },
      { id: "claude-opus-4-8-20260528", releaseDate: "2026-05-28" }, // dated → excluded
      { id: "claude-3-5-haiku-latest", releaseDate: "2024-10-22" }, // -latest → excluded
      { id: "claude-haiku-4-5", releaseDate: "2025-10-15" },
      { id: "claude-3-haiku-20240307", releaseDate: "2024-03-13" }, // dated → excluded
      { id: "claude-fable-5", releaseDate: "2026-06-09" },
    ]);
    expect(map.opus).toBe("claude-opus-4-8");
    expect(map.haiku).toBe("claude-haiku-4-5");
    expect(map.fable).toBe("claude-fable-5");
  });

  test("old multi-token families resolve via alphabetic-token extraction", () => {
    const map = buildClaudeAliasMap([
      { id: "claude-3-5-sonnet-20240620", releaseDate: "2024-06-20" }, // dated → excluded
      { id: "claude-sonnet-4-0", releaseDate: "2025-05-22" },
      { id: "claude-sonnet-4-6", releaseDate: "2026-02-17" },
    ]);
    expect(map.sonnet).toBe("claude-sonnet-4-6");
  });

  test("release_date ties break by lexicographically greatest id", () => {
    const map = buildClaudeAliasMap([
      { id: "claude-mythos-4", releaseDate: "2026-06-09" },
      { id: "claude-mythos-5", releaseDate: "2026-06-09" },
    ]);
    expect(map.mythos).toBe("claude-mythos-5");
  });

  test("null release_date sorts before any real date", () => {
    const map = buildClaudeAliasMap([
      { id: "claude-opus-9", releaseDate: null },
      { id: "claude-opus-4-8", releaseDate: "2026-05-28" },
    ]);
    expect(map.opus).toBe("claude-opus-4-8");
  });

  test("non-claude ids never contribute", () => {
    const map = buildClaudeAliasMap([{ id: "gpt-5-fable", releaseDate: "2026-01-01" }]);
    expect(map).toEqual({});
  });
});

describe("resolveClaudeAlias", () => {
  const map = { fable: "claude-fable-5" };
  test("case/whitespace-insensitive hit", () => {
    expect(resolveClaudeAlias(" Fable ", map)).toBe("claude-fable-5");
  });
  test("non-alias returns null (concrete ids pass through elsewhere)", () => {
    expect(resolveClaudeAlias("claude-fable-5", map)).toBeNull();
    expect(resolveClaudeAlias("opus", map)).toBeNull();
  });
});

describe("against the committed models.dev snapshot", () => {
  test("fable resolves to claude-fable-5 (round-7 item 4/8)", async () => {
    const map = await getClaudeAliasMap();
    expect(map.fable).toBe("claude-fable-5");
  });

  test("every standing alias resolves to an undated claude id", async () => {
    const map = await getClaudeAliasMap();
    for (const alias of ["opus", "sonnet", "haiku", "fable"]) {
      const id = map[alias];
      expect(id).toBeDefined();
      expect(id).toStartWith("claude");
      expect(id).toContain(alias);
      expect(id).not.toMatch(/-\d{8}$/);
      expect(id?.endsWith("-latest")).toBe(false);
    }
  });

  test("lookupModelCost prices bare aliases via the alias map", async () => {
    const fable = await lookupModelCost("claude", "fable");
    expect(fable?.id).toBe("claude-fable-5");
    expect(fable?.inputPerM).not.toBeNull();
    const haiku = await lookupModelCost("claude", "haiku");
    expect(haiku?.id).toBe("claude-haiku-4-5");
  });
});
