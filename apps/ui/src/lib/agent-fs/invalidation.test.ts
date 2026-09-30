import { describe, expect, test } from "bun:test";
import { combEventPath, keysToInvalidate, type LiveKeyContext } from "./invalidation";
import type { CommentChangedEvent, FileChangedEvent } from "./stream";

const CTX: LiveKeyContext = {
  endpoint: "http://fs.test",
  userId: "user-1",
  orgId: "org-1",
  driveId: "drive-1",
};
const PREFIX = ["agent-fs", "http://fs.test", "user-1", "org-1", "drive-1"];

function fileChanged(path: string, operation: FileChangedEvent["operation"] = "write") {
  return {
    type: "file.changed",
    driveId: "drive-1",
    path,
    version: 2,
    operation,
    actor: "user-2",
    at: "2026-09-30T10:00:00.000Z",
  } satisfies FileChangedEvent;
}

function commentChanged(path: string) {
  return {
    type: "comment.changed",
    driveId: "drive-1",
    path,
    commentId: "c1",
    parentId: null,
    action: "created",
    actor: "user-2",
    at: "2026-09-30T10:00:00.000Z",
  } satisfies CommentChangedEvent;
}

describe("combEventPath", () => {
  test("gives one leading slash for either stored form", () => {
    expect(combEventPath("docs/a.md")).toBe("/docs/a.md");
    expect(combEventPath("/docs/a.md")).toBe("/docs/a.md");
    expect(combEventPath("//docs/a.md")).toBe("/docs/a.md");
  });
});

describe("keysToInvalidate", () => {
  test("file.changed: the file's stat and the listing of every folder above it", () => {
    expect(keysToInvalidate(fileChanged("/a/b/c.md"), CTX)).toEqual([
      [...PREFIX, "stat", "/a/b/c.md"],
      [...PREFIX, "ls", "/"],
      [...PREFIX, "ls", "/a/"],
      [...PREFIX, "ls", "/a/b/"],
    ]);
  });

  test("file.changed at the root refreshes the root listing only", () => {
    expect(keysToInvalidate(fileChanged("notes.md", "delete"), CTX)).toEqual([
      [...PREFIX, "stat", "/notes.md"],
      [...PREFIX, "ls", "/"],
    ]);
  });

  test("a move (write at the new path, delete at the old) refreshes both parents", () => {
    const keys = [
      ...keysToInvalidate(fileChanged("docs/new.md", "write"), CTX),
      ...keysToInvalidate(fileChanged("drafts/old.md", "delete"), CTX),
    ];
    expect(keys).toContainEqual([...PREFIX, "ls", "/docs/"]);
    expect(keys).toContainEqual([...PREFIX, "ls", "/drafts/"]);
    expect(keys).toContainEqual([...PREFIX, "stat", "/docs/new.md"]);
    expect(keys).toContainEqual([...PREFIX, "stat", "/drafts/old.md"]);
  });

  test("comment.changed: the file's comments and each folder comment list above it", () => {
    const expected = [
      [...PREFIX, "comments", "/a/b/c.md"],
      [...PREFIX, "comments", "prefix", "/"],
      [...PREFIX, "comments", "prefix", "/a/"],
      [...PREFIX, "comments", "prefix", "/a/b/"],
    ];
    // agent-fs stores a comment path as sent: both forms give the Comb keys.
    expect(keysToInvalidate(commentChanged("a/b/c.md"), CTX)).toEqual(expected);
    expect(keysToInvalidate(commentChanged("/a/b/c.md"), CTX)).toEqual(expected);
  });

  test("ready (connect and every reconnect): every stat, ls, and comments query of the drive", () => {
    expect(
      keysToInvalidate({ type: "ready", driveId: "drive-1", at: "2026-09-30T10:00:00.000Z" }, CTX),
    ).toEqual([
      [...PREFIX, "stat"],
      [...PREFIX, "ls"],
      [...PREFIX, "comments"],
    ]);
  });
});
