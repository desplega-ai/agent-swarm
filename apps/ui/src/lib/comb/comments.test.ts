import { describe, expect, test } from "bun:test";
import type { CommentListEntry } from "../agent-fs/types";
import { commentReadPaths, commentWritePath, mergeCommentLists, versionAt } from "./comments";

function thread(id: string, createdAt: string): CommentListEntry {
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
  };
}

describe("comment paths", () => {
  test("Comb writes the live/ form and reads both stored forms", () => {
    expect(commentWritePath("/comb-qa/notes.md")).toBe("comb-qa/notes.md");
    expect(commentReadPaths("/comb-qa/notes.md")).toEqual([
      "comb-qa/notes.md",
      "/comb-qa/notes.md",
    ]);
  });

  test("a comment's version is the newest one written at or before it", () => {
    const versions = [
      { version: 3, createdAt: "2026-09-30T10:00:00.000Z" },
      { version: 2, createdAt: "2026-09-30T09:00:00.000Z" },
      { version: 1, createdAt: "2026-09-30T08:00:00.000Z" },
    ];
    expect(versionAt(versions, "2026-09-30T09:30:00.000Z")).toBe(2);
    expect(versionAt(versions, "2026-09-30T10:00:00.000Z")).toBe(3);
    expect(versionAt(versions, "2026-09-30T07:00:00.000Z")).toBeUndefined();
  });

  test("merged lists have no duplicates and are newest first", () => {
    const a = thread("a", "2026-09-30T08:00:00Z");
    const b = thread("b", "2026-09-30T09:00:00Z");
    expect(mergeCommentLists([[a], [b, a]]).map((t) => t.id)).toEqual(["b", "a"]);
  });
});
