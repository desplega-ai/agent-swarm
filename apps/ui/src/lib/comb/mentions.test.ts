import { describe, expect, test } from "bun:test";
import type { DriveMember } from "../agent-fs/types";
import {
  activeMentionQuery,
  collectMentionIds,
  insertMention,
  labelMembers,
  mentionRoute,
  splitMentions,
} from "./mentions";

function member(userId: string, email: string, displayName: string | null = null): DriveMember {
  return { userId, email, displayName };
}

describe("activeMentionQuery", () => {
  test("detects a query at the start of the text", () => {
    expect(activeMentionQuery("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(activeMentionQuery("@al", 3)).toEqual({ start: 0, end: 3, query: "al" });
  });

  test("detects a query after a space and after a newline", () => {
    expect(activeMentionQuery("hi @bo", 6)).toEqual({ start: 3, end: 6, query: "bo" });
    expect(activeMentionQuery("line\n@", 6)).toEqual({ start: 5, end: 6, query: "" });
  });

  test("does not open inside an email or a word", () => {
    expect(activeMentionQuery("a@b.com", 7)).toBeNull();
    expect(activeMentionQuery("mail me@x", 9)).toBeNull();
  });

  test("closes after a space and when the caret is before the @", () => {
    expect(activeMentionQuery("@al ", 4)).toBeNull();
    expect(activeMentionQuery("x @al", 1)).toBeNull();
  });

  test("covers the rest of the word under the caret", () => {
    // Caret between "al" and "ice": a pick replaces the whole word.
    expect(activeMentionQuery("@alice done", 3)).toEqual({ start: 0, end: 6, query: "al" });
  });

  test("allows letters with accents, dots, and dashes in the query", () => {
    expect(activeMentionQuery("@josé.m-r", 9)?.query).toBe("josé.m-r");
  });
});

describe("insertMention", () => {
  test("replaces the query with the label and a space, and puts the caret after it", () => {
    const text = "hey @al";
    const range = activeMentionQuery(text, text.length);
    expect(range).not.toBeNull();
    const next = insertMention(text, range as { start: number; end: number }, "Alice");
    expect(next).toEqual({ text: "hey @Alice ", caret: 11 });
  });

  test("keeps the text after the caret and reuses a following space", () => {
    const next = insertMention("@al can you check?", { start: 0, end: 3 }, "Alice Lee");
    expect(next.text).toBe("@Alice Lee can you check?");
    expect(next.caret).toBe("@Alice Lee ".length);
  });

  test("adds a space before other text", () => {
    expect(insertMention("@s,", { start: 0, end: 2 }, "swarm")).toEqual({
      text: "@swarm ,",
      caret: 7,
    });
  });
});

describe("collectMentionIds", () => {
  const labels = new Map([
    ["Alice", "u-alice"],
    ["Alice Lee", "u-alee"],
    ["bob", "u-bob"],
  ]);

  test("returns the ids of the labels written in the body, in body order", () => {
    expect(collectMentionIds("@bob and @Alice, please", labels)).toEqual(["u-bob", "u-alice"]);
  });

  test("a deleted token drops its mention", () => {
    expect(collectMentionIds("@bob and please", labels)).toEqual(["u-bob"]);
    expect(collectMentionIds("bob and Alice", labels)).toEqual([]);
  });

  test("prefers the longest label and ignores partial names", () => {
    expect(collectMentionIds("@Alice Lee can you check?", labels)).toEqual(["u-alee"]);
    expect(collectMentionIds("@bobby and @alice.smith", labels)).toEqual([]);
  });

  test("ignores tokens inside emails and repeats", () => {
    expect(collectMentionIds("mail x@bob.io", labels)).toEqual([]);
    expect(collectMentionIds("@bob @bob. (@BOB)", labels)).toEqual(["u-bob"]);
  });
});

describe("labelMembers", () => {
  test("uses the display name, else the email local part", () => {
    const labeled = labelMembers([member("1", "ann@x.io", "Ann"), member("2", "bo@x.io")]);
    expect(labeled.map((l) => l.label)).toEqual(["Ann", "bo"]);
  });

  test("appends the email local part to duplicate labels", () => {
    const labeled = labelMembers([
      member("1", "alex.a@x.io", "Alex"),
      member("2", "alex.b@y.io", "alex"),
      member("3", "sam@x.io", "Sam"),
    ]);
    expect(labeled.map((l) => l.label)).toEqual(["Alex (alex.a)", "alex (alex.b)", "Sam"]);
  });

  test("falls back to the full email when the local parts also repeat", () => {
    const labeled = labelMembers([member("1", "a@x.io"), member("2", "a@y.io")]);
    expect(labeled.map((l) => l.label)).toEqual(["a (a)", "a (a@y.io)"]);
  });

  test("never labels a member 'swarm'", () => {
    expect(labelMembers([member("1", "swarm@x.io")])[0].label).toBe("swarm (swarm)");
  });
});

describe("splitMentions", () => {
  const ann = { userId: "u-ann", email: "ann@x.io", displayName: "Ann Lee" };

  test("returns plain text when there are no mentions", () => {
    expect(splitMentions("@Ann Lee hi", undefined)).toEqual([
      { kind: "text", text: "@Ann Lee hi" },
    ]);
  });

  test("marks the display name, the local part, and the email of a mention", () => {
    expect(splitMentions("@Ann Lee and @ann and @ann@x.io.", [ann])).toEqual([
      { kind: "mention", text: "@Ann Lee", mention: ann },
      { kind: "text", text: " and " },
      { kind: "mention", text: "@ann", mention: ann },
      { kind: "text", text: " and " },
      { kind: "mention", text: "@ann@x.io", mention: ann },
      { kind: "text", text: "." },
    ]);
  });

  test("leaves other @words alone", () => {
    expect(splitMentions("@bob and me@ann", [ann])).toEqual([
      { kind: "text", text: "@bob and me@ann" },
    ]);
  });
});

describe("mentionRoute", () => {
  const drive = { orgId: "org-1", driveId: "drive-1" };

  test("opens a root comment's thread on its file, from either stored path form", () => {
    const entry = { path: "comb-qa/notes.md", commentId: "c-1" };
    expect(mentionRoute(drive, entry)).toBe("/file/~/org-1/drive-1/comb-qa/notes.md?comment=c-1");
    expect(mentionRoute(drive, { ...entry, path: "/comb-qa/notes.md" })).toBe(
      "/file/~/org-1/drive-1/comb-qa/notes.md?comment=c-1",
    );
  });

  test("a reply opens its root thread", () => {
    expect(mentionRoute(drive, { path: "a b.md", commentId: "reply-1", parentId: "root-1" })).toBe(
      "/file/~/org-1/drive-1/a%20b.md?comment=root-1",
    );
  });
});
