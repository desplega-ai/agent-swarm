import { describe, expect, test } from "bun:test";
import type { CommentListEntry } from "../agent-fs/types";
import {
  anchorInputs,
  COMB_LOG_LIMIT,
  COMMENT_LIST_MAX,
  COMMENT_PAGE_SIZE,
  commentCombPath,
  commentReadPaths,
  commentWritePath,
  lineRangeLabel,
  listFileThreads,
  mergeCommentLists,
  versionAt,
} from "./comments";

function thread(
  id: string,
  createdAt: string,
  overrides: Partial<CommentListEntry> = {},
): CommentListEntry {
  return {
    id,
    path: "comb-qa/notes.md",
    body: id,
    author: "u",
    resolved: false,
    replyCount: 0,
    createdAt,
    updatedAt: createdAt,
    replies: [],
    ...overrides,
  };
}

const VERSIONS = [
  { version: 3, createdAt: "2026-09-30T10:00:00.000Z" },
  { version: 2, createdAt: "2026-09-30T09:00:00.000Z" },
  { version: 1, createdAt: "2026-09-30T08:00:00.000Z" },
];

describe("comment paths", () => {
  test("Comb writes the live/ form and reads both stored forms", () => {
    expect(commentWritePath("/comb-qa/notes.md")).toBe("comb-qa/notes.md");
    expect(commentReadPaths("/comb-qa/notes.md")).toEqual([
      "comb-qa/notes.md",
      "/comb-qa/notes.md",
    ]);
    expect(commentCombPath("comb-qa/notes.md")).toBe("/comb-qa/notes.md");
    expect(commentCombPath("//comb-qa/notes.md")).toBe("/comb-qa/notes.md");
  });

  test("line labels read L3, L3-5, or nothing", () => {
    expect(lineRangeLabel(3, 5)).toBe("L3-5");
    expect(lineRangeLabel(3, 3)).toBe("L3");
    expect(lineRangeLabel(3)).toBe("L3");
    expect(lineRangeLabel(undefined, 5)).toBeNull();
  });

  test("a comment's version is the newest one written at or before it", () => {
    expect(versionAt(VERSIONS, "2026-09-30T09:30:00.000Z")).toBe(2);
    expect(versionAt(VERSIONS, "2026-09-30T10:00:00.000Z")).toBe(3);
    expect(versionAt(VERSIONS, "2026-09-30T07:00:00.000Z")).toBeUndefined();
  });

  test("a comment older than a cut-off log takes the oldest listed version", () => {
    // The log hit its limit: versions older than v1 exist but are not listed.
    expect(versionAt(VERSIONS, "2026-09-30T07:00:00.000Z", false)).toBe(1);
    expect(versionAt(VERSIONS, "2026-09-30T09:30:00.000Z", false)).toBe(2);
  });

  test("merged lists have no duplicates and are newest first", () => {
    const a = thread("a", "2026-09-30T08:00:00Z");
    const b = thread("b", "2026-09-30T09:00:00Z");
    expect(mergeCommentLists([[a], [b, a]]).map((t) => t.id)).toEqual(["b", "a"]);
  });
});

/** `count` threads, newest first, one second apart. */
function threads(prefix: string, count: number, start = Date.UTC(2026, 8, 30)) {
  return Array.from({ length: count }, (_, i) =>
    thread(`${prefix}${i}`, new Date(start - i * 1000).toISOString()),
  );
}

describe("listFileThreads", () => {
  test("pages each path form until a short page", async () => {
    const stored: Record<string, CommentListEntry[]> = {
      "comb-qa/notes.md": threads("a", COMMENT_PAGE_SIZE + 5),
      "/comb-qa/notes.md": threads("b", 3, Date.UTC(2026, 8, 29)),
    };
    const calls: string[] = [];
    const result = await listFileThreads(
      commentReadPaths("/comb-qa/notes.md"),
      async (path, offset, limit) => {
        calls.push(`${path}@${offset}`);
        return stored[path].slice(offset, offset + limit);
      },
    );
    expect(calls.sort()).toEqual([
      "/comb-qa/notes.md@0",
      "comb-qa/notes.md@0",
      "comb-qa/notes.md@200",
    ]);
    expect(result.threads).toHaveLength(COMMENT_PAGE_SIZE + 8);
    expect(result.truncated).toBe(false);
    expect(result.threads[0].id).toBe("a0");
  });

  test("stops at the newest 2,000 threads and says so", async () => {
    const all = threads("a", COMMENT_LIST_MAX + 300);
    let calls = 0;
    const result = await listFileThreads(["comb-qa/notes.md"], async (_path, offset, limit) => {
      calls++;
      return all.slice(offset, offset + limit);
    });
    expect(calls).toBe(COMMENT_LIST_MAX / COMMENT_PAGE_SIZE);
    expect(result.threads).toHaveLength(COMMENT_LIST_MAX);
    expect(result.threads[0].id).toBe("a0");
    expect(result.truncated).toBe(true);
  });
});

describe("anchorInputs (useCommentAnchors' log fallback)", () => {
  const anchored = (id: string, createdAt: string, fileVersion?: number) =>
    thread(id, createdAt, {
      quote: { exact: "Second paragraph." },
      lineStart: 5,
      lineEnd: 5,
      fileVersion,
    });

  test("a comment without fileVersion waits for the log, then takes its version from it", () => {
    const comment = anchored("c", "2026-09-30T09:30:00.000Z");
    expect(anchorInputs([comment], 3, { loading: true })).toEqual([]);
    const [input] = anchorInputs([comment], 3, { loading: false, versions: VERSIONS });
    expect(input.version).toBe(2);
    expect(input.input.stale).toBe(true);
  });

  test("a comment older than a full log is treated as stale from the oldest listed version", () => {
    const full = Array.from({ length: COMB_LOG_LIMIT }, (_, i) => ({
      version: COMB_LOG_LIMIT - i + 100,
      createdAt: new Date(Date.UTC(2026, 8, 30) - i * 1000).toISOString(),
    }));
    const [input] = anchorInputs([anchored("c", "2026-01-01T00:00:00.000Z")], 300, {
      loading: false,
      versions: full,
    });
    expect(input.version).toBe(101);
    expect(input.input.stale).toBe(true);
  });

  test("a stored fileVersion wins, and file-level comments have no input", () => {
    const inputs = anchorInputs(
      [anchored("c", "2026-09-30T09:30:00.000Z", 3), thread("f", "2026-09-30T09:30:00.000Z")],
      3,
      { loading: true },
    );
    expect(inputs.map((i) => [i.id, i.version, i.input.stale])).toEqual([["c", undefined, false]]);
  });
});
