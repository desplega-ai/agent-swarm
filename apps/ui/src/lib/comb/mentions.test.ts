import { describe, expect, test } from "bun:test";
import type {
  CommentNotificationEntry,
  CommentNotificationListResult,
  DriveMember,
} from "../agent-fs/types";
import { hasSwarmMarker } from "./markers";
import {
  activeMentionQuery,
  collectMentionIds,
  insertMention,
  labelMembers,
  markMentionsRead,
  mentionPicks,
  mentionRoute,
  pickableMembers,
  pickerItems,
  splitMentions,
} from "./mentions";

function member(userId: string, email: string, displayName: string | null = null): DriveMember {
  return { userId, email, displayName };
}

describe("pickableMembers", () => {
  const members = [
    member("u-me", "me@example.com", "Me"),
    member("u-bob", "bob@example.com", "Bob"),
    member("u-agent", "worker-1@swarm.local", "Worker 1"),
    member("u-lead", "Lead@Swarm.Local"),
    member("u-service", "swarm-admin@agent-fs.local"),
  ];

  test("drops the caller and the swarm's agent accounts", () => {
    expect(pickableMembers(members, "u-me").map((m) => m.userId)).toEqual(["u-bob", "u-service"]);
  });

  test("drops the swarm service account when its id is known", () => {
    expect(pickableMembers(members, "u-me", "u-service").map((m) => m.userId)).toEqual(["u-bob"]);
  });

  test("keeps everyone else without a caller id", () => {
    expect(pickableMembers(members, null).map((m) => m.userId)).toEqual([
      "u-me",
      "u-bob",
      "u-service",
    ]);
  });
});

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

  test("reads a query of up to 64 characters", () => {
    const long = `@${"a".repeat(64)}`;
    expect(activeMentionQuery(long, long.length)?.query).toBe("a".repeat(64));
    const tooLong = `@${"a".repeat(65)}`;
    expect(activeMentionQuery(tooLong, tooLong.length)).toBeNull();
  });

  test("returns quickly on a 20k-character unbroken word", () => {
    const word = "a".repeat(20_000);
    const started = performance.now();
    for (const text of [`${word} `, `${word}!`, `x @${word}`, word]) {
      expect(activeMentionQuery(text, text.length)).toBeNull();
    }
    expect(performance.now() - started).toBeLessThan(50);
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
  const picked = new Map([
    ["Alice", "u-alice"],
    ["Alice Lee", "u-alee"],
    ["bob", "u-bob"],
  ]);

  test("returns the ids of the picked labels written in the body, in body order", () => {
    expect(collectMentionIds("@bob and @Alice, please", picked)).toEqual(["u-bob", "u-alice"]);
  });

  test("a deleted token drops its mention", () => {
    expect(collectMentionIds("@bob and please", picked)).toEqual(["u-bob"]);
    expect(collectMentionIds("bob and Alice", picked)).toEqual([]);
  });

  test("prefers the longest picked label and ignores partial names", () => {
    expect(collectMentionIds("@Alice Lee can you check?", picked)).toEqual(["u-alee"]);
    expect(collectMentionIds("@bobby and @alice.smith", picked)).toEqual([]);
  });

  test("ignores tokens inside emails and repeats", () => {
    expect(collectMentionIds("mail x@bob.io", picked)).toEqual([]);
    expect(collectMentionIds("@bob @bob. (@BOB)", picked)).toEqual(["u-bob"]);
  });

  test("'Ann' picked, then 'Lee is on it' typed, mentions Ann only", () => {
    // "Ann Lee" is a member too, but nobody picked her.
    const labeled = labelMembers([
      member("u-ann", "ann@x.io", "Ann"),
      member("u-lee", "al@x.io", "Ann Lee"),
    ]);
    expect(labeled.map((l) => l.label)).toEqual(["Ann", "Ann Lee"]);
    const range = activeMentionQuery("@An", 3);
    const next = insertMention("@An", range as { start: number; end: number }, "Ann");
    const body = `${next.text}Lee is on it`;
    expect(body).toBe("@Ann Lee is on it");
    expect(collectMentionIds(body, new Map([["Ann", "u-ann"]]))).toEqual(["u-ann"]);
  });

  test("a typed name that was not picked mentions nobody", () => {
    const labeled = labelMembers([member("u-admin", "admin@x.io")]);
    expect(labeled[0].label).toBe("admin");
    expect(collectMentionIds("ask @admin", new Map())).toEqual([]);
    expect(collectMentionIds("@Ann, ask @admin", new Map([["Ann", "u-ann"]]))).toEqual(["u-ann"]);
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

  test("a label that would read as the @swarm marker is reserved", () => {
    const labeled = labelMembers([
      member("1", "swarm@x.io"),
      member("2", "fan@x.io", "Swarm Fan"),
      member("3", "swarm@y.io", "swarm"),
    ]);
    expect(labeled.map((l) => l.label)).toEqual(["swarm@x.io", "fan", "swarm@y.io"]);
    for (const { label } of labeled) expect(hasSwarmMarker(`@${label} please`)).toBe(false);
  });

  test("a label that only starts with swarm stays (the marker needs a word end)", () => {
    const labeled = labelMembers([
      member("1", "swarm-admin@agent-fs.local"),
      member("2", "s@x.io", "Swarmy"),
    ]);
    expect(labeled.map((l) => l.label)).toEqual(["swarm-admin", "Swarmy"]);
    for (const { label } of labeled) expect(hasSwarmMarker(`@${label} please`)).toBe(false);
  });
});

describe("pickerItems", () => {
  const labeled = labelMembers([
    member("u-ann", "ann@x.io", "Ann Lee"),
    member("u-bob", "bob@swarmcorp.io", "Bob"),
  ]);

  test("lists the swarm entry first, then every member for an empty query", () => {
    expect(pickerItems(labeled, "").map((item) => [item.label, item.userId])).toEqual([
      ["swarm", null],
      ["Ann Lee", "u-ann"],
      ["Bob", "u-bob"],
    ]);
  });

  test("matches the label or the email, case-insensitively", () => {
    expect(pickerItems(labeled, "LEE").map((item) => item.userId)).toEqual(["u-ann"]);
    expect(pickerItems(labeled, "ann@x").map((item) => item.userId)).toEqual(["u-ann"]);
    // "sw" matches the swarm entry and Bob's email.
    expect(pickerItems(labeled, "sw").map((item) => item.label)).toEqual(["swarm", "Bob"]);
    expect(pickerItems(labeled, "zed")).toEqual([]);
  });

  test("finds a reserved label by the display name, and the detail names the member", () => {
    const fan = labelMembers([member("u-fan", "fan@x.io", "Swarm Fan")]);
    expect(pickerItems(fan, "swarm")).toEqual([
      { value: "swarm", label: "swarm", detail: "Send to the swarm", userId: null },
      { value: "member:u-fan", label: "fan", detail: "Swarm Fan · fan@x.io", userId: "u-fan" },
    ]);
    expect(pickerItems(labeled, "Bob")[0].detail).toBe("bob@swarmcorp.io");
  });
});

describe("a disambiguated label round trip", () => {
  test("pick, insert, send, and render the chip", () => {
    const alexB = member("u-alex-b", "alex.b@y.io", "alex");
    const labeled = labelMembers([member("u-alex-a", "alex.a@x.io", "Alex"), alexB]);
    const item = pickerItems(labeled, "alex.b")[0];
    expect(item).toMatchObject({ label: "alex (alex.b)", userId: "u-alex-b" });

    const text = "cc @alex.b";
    const range = activeMentionQuery(text, text.length) as { start: number; end: number };
    const next = insertMention(text, range, item.label);
    const body = `${next.text}please`;
    expect(body).toBe("cc @alex (alex.b) please");

    const picked = new Map([[item.label, item.userId as string]]);
    expect(collectMentionIds(body, picked)).toEqual(["u-alex-b"]);
    expect(splitMentions(body, [alexB])).toEqual([
      { kind: "text", text: "cc " },
      { kind: "mention", text: "@alex (alex.b)", mention: alexB },
      { kind: "text", text: " please" },
    ]);
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

describe("mentionPicks", () => {
  const ann = { userId: "u-ann", email: "ann@x.io", displayName: "Ann Lee" };
  const bob = { userId: "u-bob", email: "bob@x.io", displayName: null };

  test("maps each mention token of a saved comment to its user id", () => {
    const picks = mentionPicks("@Ann Lee and @bob, please check", [ann, bob]);
    expect([...picks]).toEqual([
      ["Ann Lee", "u-ann"],
      ["bob", "u-bob"],
    ]);
    // An edit that keeps a token keeps its mention. A removed token drops it.
    expect(collectMentionIds("@Ann Lee, please check", picks)).toEqual(["u-ann"]);
  });

  test("is empty without mentions", () => {
    expect(mentionPicks("@Ann Lee hi", undefined).size).toBe(0);
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

describe("markMentionsRead", () => {
  function entry(id: string, read: boolean): CommentNotificationEntry {
    return {
      id,
      kind: "mention",
      commentId: `c-${id}`,
      path: "notes.md",
      body: "@Ann hi",
      actor: "u-bob",
      createdAt: "2026-09-30T10:00:00.000Z",
      read,
    };
  }
  const list: CommentNotificationListResult = {
    notifications: [entry("n1", false), entry("n2", false), entry("n3", true)],
    unreadCount: 5, // Unread mentions beyond the 20 listed count too.
  };

  test("marks the given ids read and lowers the count by the newly read ones", () => {
    const next = markMentionsRead(list, ["n1", "n3"]);
    expect(next.notifications.map((n) => [n.id, n.read])).toEqual([
      ["n1", true],
      ["n2", false],
      ["n3", true],
    ]);
    expect(next.unreadCount).toBe(4);
    // The input list is not changed.
    expect(list.notifications[0].read).toBe(false);
  });

  test("null marks every entry read and zeroes the count", () => {
    const next = markMentionsRead(list, null);
    expect(next.notifications.every((n) => n.read)).toBe(true);
    expect(next.unreadCount).toBe(0);
  });

  test("the count never goes below 0", () => {
    const stale = { ...list, unreadCount: 1 };
    expect(markMentionsRead(stale, ["n1", "n2"]).unreadCount).toBe(0);
  });
});
