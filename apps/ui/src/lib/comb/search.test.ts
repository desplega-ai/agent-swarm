import { describe, expect, test } from "bun:test";
import { AgentFsError } from "../agent-fs/client";
import {
  isSearchable,
  isUnknownOpError,
  literalFtsPattern,
  NAME_RESULT_LIMIT,
  nextSearchMode,
  SEMANTIC_RESULT_LIMIT,
  searchModeFromParam,
  searchModeParam,
  searchOutcome,
  searchParams,
  snippetParts,
} from "./search";

describe("isSearchable", () => {
  test("name search waits for two characters", () => {
    expect(isSearchable("name", "a")).toBe(false);
    expect(isSearchable("name", " a ")).toBe(false);
    expect(isSearchable("name", "ab")).toBe(true);
  });

  test("full text and semantic run on any non-blank query", () => {
    expect(isSearchable("text", "a")).toBe(true);
    expect(isSearchable("semantic", "a")).toBe(true);
    expect(isSearchable("text", "   ")).toBe(false);
    expect(isSearchable("semantic", "")).toBe(false);
  });
});

describe("literalFtsPattern", () => {
  test("quotes each word and joins them with AND", () => {
    expect(literalFtsPattern("cache stampede")).toBe('"cache" AND "stampede"');
  });

  test("keeps FTS5 syntax characters literal", () => {
    expect(literalFtsPattern('a-b say "hi" OR x*')).toBe(
      '"a-b" AND "say" AND """hi""" AND "OR" AND "x*"',
    );
  });

  test("an empty query is an empty pattern", () => {
    expect(literalFtsPattern("  ")).toBe("");
  });
});

describe("searchParams", () => {
  test("maps each mode to its op params", () => {
    expect(searchParams("name", " notes ")).toEqual({ query: "notes", limit: NAME_RESULT_LIMIT });
    expect(searchParams("name", "notes", "/docs/")).toEqual({
      query: "notes",
      limit: NAME_RESULT_LIMIT,
      path: "/docs/",
    });
    expect(searchParams("name", "notes", "/")).toEqual({
      query: "notes",
      limit: NAME_RESULT_LIMIT,
    });
    expect(searchParams("text", "road map")).toEqual({ pattern: '"road" AND "map"' });
    expect(searchParams("semantic", "files stored")).toEqual({
      query: "files stored",
      limit: SEMANTIC_RESULT_LIMIT,
    });
  });
});

describe("snippetParts", () => {
  test("marks the <b> words and collapses whitespace", () => {
    expect(snippetParts("# Weekly sync\n\n## Quarterly <b>roadmap</b>\n\nWe agreed")).toEqual([
      { text: "# Weekly sync ## Quarterly ", hit: false },
      { text: "roadmap", hit: true },
      { text: " We agreed", hit: false },
    ]);
  });

  test("keeps file HTML as plain text", () => {
    const parts = snippetParts(
      '<img src=x onerror="alert(1)"> and <b>files</b><script>x()</script>',
    );
    expect(parts).toEqual([
      { text: '<img src=x onerror="alert(1)"> and ', hit: false },
      { text: "files", hit: true },
      { text: "<script>x()</script>", hit: false },
    ]);
  });

  test("trims the ends and drops empty parts", () => {
    expect(snippetParts("  <b>a</b>  ")).toEqual([{ text: "a", hit: true }]);
    expect(snippetParts("")).toEqual([]);
  });
});

describe("searchOutcome", () => {
  test("name: paths become Comb paths with their folder, total keeps the cap", () => {
    const outcome = searchOutcome("name", {
      matches: [
        { path: "/docs/meeting-notes.md", size: 10, score: 36 },
        { path: "notes.md", size: 5, score: 20 },
      ],
      total: 120,
    });
    expect(outcome.total).toBe(120);
    expect(outcome.hint).toBeNull();
    expect(outcome.hits).toEqual([
      {
        path: "/docs/meeting-notes.md",
        name: "meeting-notes.md",
        folder: "/docs/",
        snippet: [],
        chip: null,
        size: 10,
        modifiedAt: undefined,
      },
      {
        path: "/notes.md",
        name: "notes.md",
        folder: "/",
        snippet: [],
        chip: null,
        size: 5,
        modifiedAt: undefined,
      },
    ]);
  });

  test("full text: snippets are parsed, and an empty answer gets Comb's hint", () => {
    const hit = searchOutcome("text", {
      matches: [{ path: "/a.md", snippet: "x <b>y</b>", rank: -1 }],
      tookMs: 1,
    });
    expect(hit.hits[0]?.snippet).toEqual([
      { text: "x ", hit: false },
      { text: "y", hit: true },
    ]);
    const empty = searchOutcome("text", { matches: [], hint: "No exact token matches", tookMs: 0 });
    expect(empty.hits).toEqual([]);
    expect(empty.hint).toBe("Full text matches exact words. Try Semantic.");
  });

  test("semantic: chips for PDF pages and images, the image marker is dropped, duplicates collapse", () => {
    const outcome = searchOutcome("semantic", {
      results: [
        { path: "/reports/q3.pdf", score: 1, snippet: "revenue grew", page: 3, kind: "text" },
        { path: "/images/diagram.png", score: 0.9, snippet: "[image]", kind: "image" },
        { path: "reports/q3.pdf", score: 0.5, snippet: "again" },
      ],
      hint: "Results are keyword-only.",
    });
    expect(outcome.hits.map((hit) => [hit.path, hit.chip, hit.snippet.length])).toEqual([
      ["/reports/q3.pdf", "Page 3", 1],
      ["/images/diagram.png", "Image", 0],
    ]);
    expect(outcome.total).toBe(2);
    expect(outcome.hint).toBe("Results are keyword-only.");
  });
});

describe("isUnknownOpError", () => {
  test("matches agent-fs's answer for an op it does not know", () => {
    const error = new AgentFsError(500, "INTERNAL_ERROR", "Unknown operation: find");
    expect(isUnknownOpError(error, "find")).toBe(true);
    expect(isUnknownOpError(error, "fts")).toBe(false);
  });

  test("other errors are not unknown ops", () => {
    expect(isUnknownOpError(new AgentFsError(500, "INTERNAL_ERROR", "disk full"), "find")).toBe(
      false,
    );
    expect(isUnknownOpError(new Error("Unknown operation: find"), "find")).toBe(false);
  });
});

describe("search modes in the URL", () => {
  test("file, semantic, text round-trip, and anything else reads as file", () => {
    for (const mode of ["name", "semantic", "text"] as const) {
      expect(searchModeFromParam(searchModeParam(mode))).toBe(mode);
    }
    expect(searchModeParam("name")).toBe("file");
    expect(searchModeFromParam(null)).toBe("name");
    expect(searchModeFromParam("name")).toBe("name");
    expect(searchModeFromParam("fts")).toBe("name");
  });

  test("Tab goes file, semantic, text and wraps. Shift+Tab goes back", () => {
    expect(nextSearchMode("name", 1)).toBe("semantic");
    expect(nextSearchMode("semantic", 1)).toBe("text");
    expect(nextSearchMode("text", 1)).toBe("name");
    expect(nextSearchMode("name", -1)).toBe("text");
  });
});
