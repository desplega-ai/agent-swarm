import { describe, expect, test } from "bun:test";
import type { CommentEntry, CommentListEntry } from "../agent-fs/types";
import {
  countByFilter,
  type FilterFacts,
  filterThreads,
  isQueryEmpty,
  searchNeedle,
  threadMatchesFilter,
  threadMatchesSearch,
} from "./thread-filter";
import type { ThreadSwarmState } from "./thread-status";

let seq = 0;

function comment(overrides: Partial<CommentEntry> = {}): CommentEntry {
  seq++;
  return {
    id: `c${seq}`,
    path: "docs/a.md",
    body: "A comment",
    author: "u-ann",
    resolved: false,
    replyCount: 0,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    ...overrides,
  };
}

function thread(
  overrides: Partial<CommentEntry> = {},
  replies: CommentEntry[] = [],
): CommentListEntry {
  return { ...comment(overrides), replyCount: replies.length, replies };
}

const NAMES: Record<string, string> = {
  "u-ann": "Ann Lee",
  "u-bob": "Bob Chen",
  "u-swarm": "Swarm",
};
const authorName = (entry: CommentEntry) => entry.authorDisplayName || NAMES[entry.author] || "";

describe("searchNeedle", () => {
  test("trims and lower-cases the search text", () => {
    expect(searchNeedle("  Rollout PLAN ")).toBe("rollout plan");
    expect(searchNeedle("   ")).toBe("");
  });
});

describe("threadMatchesSearch", () => {
  const t = thread(
    {
      body: "Tighten this intro",
      quote: { exact: "The goal of this introduction", prefix: "", suffix: "" },
    },
    [comment({ author: "u-bob", body: "Platform goes first" })],
  );

  test("an empty needle matches every thread", () => {
    expect(threadMatchesSearch(t, "", authorName)).toBe(true);
  });

  test("matches the comment text, case-insensitive", () => {
    expect(threadMatchesSearch(t, searchNeedle("TIGHTEN"), authorName)).toBe(true);
  });

  test("matches the quoted passage (quote, or the older quotedContent)", () => {
    expect(threadMatchesSearch(t, "goal of this", authorName)).toBe(true);
    const old = thread({ body: "x", quotedContent: "Legacy passage" });
    expect(threadMatchesSearch(old, "legacy", authorName)).toBe(true);
  });

  test("matches a reply's text and author names", () => {
    expect(threadMatchesSearch(t, "platform", authorName)).toBe(true);
    expect(threadMatchesSearch(t, "bob chen", authorName)).toBe(true);
    expect(threadMatchesSearch(t, "ann", authorName)).toBe(true);
  });

  test("uses the stored display name before the member label", () => {
    const named = thread({ author: "u-zed", authorDisplayName: "Zed Park" });
    expect(threadMatchesSearch(named, "zed", authorName)).toBe(true);
  });

  test("does not match text that is nowhere in the thread", () => {
    expect(threadMatchesSearch(t, "budget", authorName)).toBe(false);
  });
});

describe("threadMatchesFilter", () => {
  const pending = thread({ body: "@swarm add a risk" });
  const processing = thread({ body: "@swarm tighten" });
  const mentionsMe = thread({ author: "u-bob", mentions: [mention("u-ann")] });
  const replyMentionsMe = thread({ author: "u-bob" }, [
    comment({ author: "u-bob", mentions: [mention("u-ann")] }),
  ]);
  const bobs = thread({ author: "u-bob" });
  const states = new Map<string, ThreadSwarmState>([
    [pending.id, { kind: "pending" }],
    [processing.id, { kind: "processing", taskId: "t1" }],
  ]);
  const facts: FilterFacts = { me: "u-ann", states };

  function mention(userId: string) {
    return { userId, displayName: null, email: `${userId}@x.io` };
  }

  test("all matches everything", () => {
    for (const t of [pending, processing, mentionsMe, bobs]) {
      expect(threadMatchesFilter(t, "all", facts)).toBe(true);
    }
  });

  test("pending and processing read the swarm states", () => {
    expect(threadMatchesFilter(pending, "pending", facts)).toBe(true);
    expect(threadMatchesFilter(processing, "pending", facts)).toBe(false);
    expect(threadMatchesFilter(processing, "processing", facts)).toBe(true);
    expect(threadMatchesFilter(bobs, "processing", facts)).toBe(false);
  });

  test("mentions me: the root or a reply mentions the connected user", () => {
    expect(threadMatchesFilter(mentionsMe, "mentions", facts)).toBe(true);
    expect(threadMatchesFilter(replyMentionsMe, "mentions", facts)).toBe(true);
    expect(threadMatchesFilter(bobs, "mentions", facts)).toBe(false);
  });

  test("mine: the connected user wrote the root", () => {
    expect(threadMatchesFilter(pending, "mine", facts)).toBe(true);
    expect(threadMatchesFilter(bobs, "mine", facts)).toBe(false);
  });

  test("without a connected user, mentions me and mine match nothing", () => {
    const anonymous: FilterFacts = { me: null, states };
    expect(threadMatchesFilter(mentionsMe, "mentions", anonymous)).toBe(false);
    expect(threadMatchesFilter(pending, "mine", anonymous)).toBe(false);
  });
});

describe("filterThreads and countByFilter", () => {
  const a = thread({ body: "@swarm add a cost risk" });
  const b = thread({ body: "Who owns the invites?", author: "u-bob" });
  const c = thread({ body: "Cost looks fine", author: "u-bob" });
  const facts: FilterFacts = {
    me: "u-ann",
    states: new Map<string, ThreadSwarmState>([[a.id, { kind: "pending" }]]),
  };

  test("keeps the threads that match both the search and the filter, in order", () => {
    expect(filterThreads([a, b, c], { needle: "cost", filter: "all" }, facts, authorName)).toEqual([
      a,
      c,
    ]);
    expect(
      filterThreads([a, b, c], { needle: "cost", filter: "pending" }, facts, authorName),
    ).toEqual([a]);
    expect(filterThreads([a, b, c], { needle: "", filter: "all" }, facts, authorName)).toEqual([
      a,
      b,
      c,
    ]);
  });

  test("counts each filter with the search applied", () => {
    expect(countByFilter([a, b, c], "", facts, authorName)).toEqual({
      all: 3,
      pending: 1,
      processing: 0,
      mentions: 0,
      mine: 1,
    });
    expect(countByFilter([a, b, c], "bob", facts, authorName)).toEqual({
      all: 2,
      pending: 0,
      processing: 0,
      mentions: 0,
      mine: 0,
    });
  });

  test("isQueryEmpty is true only for no search and the all filter", () => {
    expect(isQueryEmpty({ needle: "", filter: "all" })).toBe(true);
    expect(isQueryEmpty({ needle: "x", filter: "all" })).toBe(false);
    expect(isQueryEmpty({ needle: "", filter: "mine" })).toBe(false);
  });
});
