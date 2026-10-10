import { describe, expect, test } from "bun:test";
import { AgentFsError } from "../agent-fs/client";
import type { CommentAddParams, CommentListEntry } from "../agent-fs/types";
import {
  addToOutbox,
  alreadyPosted,
  anchorKeyOf,
  type CommentScope,
  claimOutbox,
  DRAFT_MAX_AGE_MS,
  type DraftStorage,
  discardFromOutbox,
  draftStorageKey,
  isRetryableSendError,
  type OutboxEntry,
  type OutboxLocks,
  type OutboxRetryOptions,
  outboxStorageKey,
  readDraft,
  readDraftMentions,
  readOutbox,
  retryOutboxEntries,
  returnToOutbox,
  sendFailureRoute,
  sweepExpiredDrafts,
  writeDraft,
  writeOutbox,
} from "./drafts";
import { collectMentionIds } from "./mentions";

function memoryStorage(): DraftStorage &
  Pick<Storage, "key" | "length"> & {
    map: Map<string, string>;
  } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  };
}

const SCOPE: CommentScope = {
  apiUrl: "http://localhost:3013",
  endpoint: "http://localhost:7433",
  userId: "user-1",
  orgId: "org-1",
  driveId: "drive-1",
  path: "/comb-qa/notes.md",
};

describe("drafts", () => {
  test("the key is namespaced by swarm, agent-fs server, user, drive, file, and composer", () => {
    expect(draftStorageKey(SCOPE, "file")).toBe(
      "swarm:v1:http://localhost:3013:comb:draft:http://localhost:7433:user-1:org-1/drive-1:/comb-qa/notes.md:file",
    );
    expect(draftStorageKey(SCOPE, "parent-1")).toEndWith(":/comb-qa/notes.md:parent-1");
  });

  test("another agent-fs user never sees the draft or the outbox", () => {
    const other = { ...SCOPE, userId: "user-2" };
    expect(draftStorageKey(other, "file")).not.toBe(draftStorageKey(SCOPE, "file"));
    expect(outboxStorageKey(other)).not.toBe(outboxStorageKey(SCOPE));
  });

  test("an anchored draft key follows the lines and the quote", () => {
    const anchor = { lineStart: 5, lineEnd: 5, quote: { exact: "Second paragraph." } };
    expect(anchorKeyOf(anchor)).toMatch(/^anchor:5-5:[0-9a-z]+$/);
    expect(anchorKeyOf(anchor)).toBe(anchorKeyOf({ ...anchor }));
    expect(anchorKeyOf(anchor)).not.toBe(
      anchorKeyOf({ ...anchor, quote: { exact: "First paragraph." } }),
    );
  });

  test("a draft survives until it is 7 days old", () => {
    const storage = memoryStorage();
    const key = draftStorageKey(SCOPE, "file");
    const now = Date.UTC(2026, 8, 30);
    writeDraft(storage, key, "Tighten this", now);
    expect(readDraft(storage, key, now + DRAFT_MAX_AGE_MS)).toBe("Tighten this");
    expect(readDraft(storage, key, now + DRAFT_MAX_AGE_MS + 1)).toBe("");
    // The expired draft is removed on read.
    expect(storage.map.has(key)).toBe(false);
  });

  test("blank text removes the draft", () => {
    const storage = memoryStorage();
    const key = draftStorageKey(SCOPE, "file");
    writeDraft(storage, key, "x", 1);
    writeDraft(storage, key, "   ", 2);
    expect(storage.map.has(key)).toBe(false);
  });

  test("the sweep removes expired and unreadable drafts of every file, and nothing else", () => {
    const storage = memoryStorage();
    const now = Date.UTC(2026, 8, 30);
    const fresh = draftStorageKey(SCOPE, "file");
    const old = draftStorageKey({ ...SCOPE, path: "/other.md" }, "file");
    const broken = draftStorageKey({ ...SCOPE, userId: "user-2" }, "file");
    writeDraft(storage, fresh, "keep", now);
    writeDraft(storage, old, "drop", now - DRAFT_MAX_AGE_MS - 1);
    storage.setItem(broken, "{not json");
    storage.setItem("swarm:v1:x:unrelated", "{not json");
    sweepExpiredDrafts(storage, now);
    expect([...storage.map.keys()].sort()).toEqual([fresh, "swarm:v1:x:unrelated"].sort());
  });

  test("a restored draft keeps its picked mentions (step-8)", () => {
    const storage = memoryStorage();
    const key = draftStorageKey(SCOPE, "file");
    const now = Date.UTC(2026, 8, 30);
    const body = "@Ann Lee is on it, ask @admin";
    writeDraft(storage, key, body, now, new Map([["Ann", "u-ann"]]));
    const restored = readDraftMentions(storage, key, now);
    expect([...restored]).toEqual([["Ann", "u-ann"]]);
    expect(readDraft(storage, key, now)).toBe(body);
    expect(collectMentionIds(readDraft(storage, key, now), restored)).toEqual(["u-ann"]);
  });

  test("a draft without picks, an expired one, or bad mention data restores no mentions", () => {
    const storage = memoryStorage();
    const key = draftStorageKey(SCOPE, "file");
    const now = Date.UTC(2026, 8, 30);
    writeDraft(storage, key, "no picks", now, new Map());
    expect(storage.map.get(key)).not.toContain("mentions");
    expect(readDraftMentions(storage, key, now).size).toBe(0);
    writeDraft(storage, key, "@Ann", now, new Map([["Ann", "u-ann"]]));
    expect(readDraftMentions(storage, key, now + DRAFT_MAX_AGE_MS + 1).size).toBe(0);
    storage.setItem(key, JSON.stringify({ text: "@Ann", savedAt: now, mentions: [["Ann"], 3] }));
    expect(readDraftMentions(storage, key, now).size).toBe(0);
  });
});

describe("send errors", () => {
  test("only network errors and 5xx go to the outbox", () => {
    expect(isRetryableSendError(new AgentFsError(0, "NETWORK", "offline"))).toBe(true);
    expect(isRetryableSendError(new AgentFsError(502, "BAD_GATEWAY", "down"))).toBe(true);
    expect(isRetryableSendError(new AgentFsError(400, "VALIDATION", "bad"))).toBe(false);
    expect(isRetryableSendError(new AgentFsError(403, "FORBIDDEN", "viewer"))).toBe(false);
  });

  test("the composer routes 403 to read-only, 5xx and network to the outbox, other 4xx inline", () => {
    expect(sendFailureRoute(new AgentFsError(403, "FORBIDDEN", "viewer"))).toBe("read-only");
    expect(sendFailureRoute(new AgentFsError(503, "UNAVAILABLE", "down"))).toBe("outbox");
    expect(sendFailureRoute(new AgentFsError(0, "NETWORK", "offline"))).toBe("outbox");
    expect(sendFailureRoute(new TypeError("Failed to fetch"))).toBe("outbox");
    expect(sendFailureRoute(new AgentFsError(400, "VALIDATION", "too long"))).toBe("inline");
    expect(sendFailureRoute(new AgentFsError(404, "NOT_FOUND", "gone"))).toBe("inline");
  });
});

const NOW = new Date("2026-09-30T08:00:00Z");
const PARAMS: CommentAddParams = { path: "comb-qa/notes.md", body: "Tighten this" };

function entry(id: string, overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    ...addToOutbox([], {
      id,
      userId: "user-1",
      params: { ...PARAMS, body: `body ${id}` },
      error: "offline",
      now: NOW,
    })[0],
    ...overrides,
  };
}

function thread(overrides: Partial<CommentListEntry>): CommentListEntry {
  return {
    id: "t",
    path: "comb-qa/notes.md",
    body: "",
    author: "user-1",
    resolved: false,
    replyCount: 0,
    createdAt: "2026-09-30T08:00:05.000Z",
    updatedAt: "2026-09-30T08:00:05.000Z",
    replies: [],
    ...overrides,
  };
}

/** A retry over a stored outbox, with sends recorded. */
function retrySetup(entries: OutboxEntry[]) {
  const storage = memoryStorage();
  const key = outboxStorageKey(SCOPE);
  writeOutbox(storage, key, entries);
  const sent: string[] = [];
  const inFlight = new Map<string, OutboxEntry>();
  const options = (overrides: Partial<OutboxRetryOptions> = {}): OutboxRetryOptions => ({
    storage,
    key,
    userId: "user-1",
    inFlight,
    send: async (params) => {
      await Promise.resolve();
      sent.push(params.body);
    },
    fetchThreads: async () => [],
    ...overrides,
  });
  return { storage, key, sent, inFlight, options };
}

describe("outbox", () => {
  test("add, read back, and discard", () => {
    const storage = memoryStorage();
    const key = outboxStorageKey(SCOPE);
    const entries = addToOutbox([], {
      id: "a",
      userId: "user-1",
      params: PARAMS,
      error: "offline",
      now: NOW,
    });
    writeOutbox(storage, key, entries);
    expect(readOutbox(storage, key)).toEqual([
      {
        id: "a",
        userId: "user-1",
        params: PARAMS,
        createdAt: "2026-09-30T08:00:00.000Z",
        error: "offline",
      },
    ]);
    writeOutbox(storage, key, discardFromOutbox(readOutbox(storage, key), "a"));
    expect(readOutbox(storage, key)).toEqual([]);
    expect(storage.map.has(key)).toBe(false);
  });

  test("an unreadable outbox reads as empty", () => {
    const storage = memoryStorage();
    storage.setItem("k", "{not json");
    expect(readOutbox(storage, "k")).toEqual([]);
    storage.setItem("k", JSON.stringify([{ id: 1 }]));
    expect(readOutbox(storage, "k")).toEqual([]);
  });

  test("a claim takes entries out of storage, and a return puts them back oldest first", () => {
    const { storage, key } = retrySetup([
      entry("a"),
      entry("b", { createdAt: "2026-09-30T08:00:01.000Z" }),
    ]);
    const claimed = claimOutbox(storage, key, (e) => e.id === "a");
    expect(claimed.map((e) => e.id)).toEqual(["a"]);
    expect(readOutbox(storage, key).map((e) => e.id)).toEqual(["b"]);
    returnToOutbox(storage, key, claimed);
    expect(readOutbox(storage, key).map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("retry keeps only the entries that fail again, with the new error", async () => {
    const { storage, key, sent, inFlight, options } = retrySetup([entry("a"), entry("b")]);
    await retryOutboxEntries(
      options({
        send: async (params) => {
          if (params.body === "body b") throw new AgentFsError(503, "UNAVAILABLE", "still down");
          sent.push(params.body);
        },
      }),
    );
    expect(sent).toEqual(["body a"]);
    expect(readOutbox(storage, key).map((e) => [e.id, e.error])).toEqual([["b", "still down"]]);
    expect(inFlight.size).toBe(0);
  });

  test("two retries at once (two tabs, or Retry and `online`) send each entry once", async () => {
    const { storage, key, sent, options } = retrySetup([entry("a"), entry("b")]);
    // Without Web Locks: the claim alone keeps the second retry off the entries.
    await Promise.all([retryOutboxEntries(options()), retryOutboxEntries(options())]);
    expect(sent.sort()).toEqual(["body a", "body b"]);
    expect(readOutbox(storage, key)).toEqual([]);
  });

  test("Web Locks run one retry per outbox at a time", async () => {
    const { key, sent, options } = retrySetup([entry("a")]);
    const names: string[] = [];
    let queue = Promise.resolve();
    const locks: OutboxLocks = {
      request: (name, callback) => {
        names.push(name);
        const run = queue.then(callback);
        queue = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    };
    await Promise.all([
      retryOutboxEntries(options({ locks })),
      retryOutboxEntries(options({ locks })),
    ]);
    expect(names).toEqual([key, key]);
    expect(sent).toEqual(["body a"]);
  });

  test("an entry added while a retry runs stays in the outbox", async () => {
    const { storage, key, sent, options } = retrySetup([entry("a")]);
    await retryOutboxEntries(
      options({
        send: async (params) => {
          writeOutbox(storage, key, [...readOutbox(storage, key), entry("late")]);
          sent.push(params.body);
        },
      }),
    );
    expect(sent).toEqual(["body a"]);
    expect(readOutbox(storage, key).map((e) => e.id)).toEqual(["late"]);
  });

  test("a failed entry goes back next to one added mid-retry", async () => {
    const { storage, key, options } = retrySetup([entry("a")]);
    await retryOutboxEntries(
      options({
        send: async () => {
          writeOutbox(storage, key, [
            ...readOutbox(storage, key),
            entry("late", { createdAt: "2026-09-30T09:00:00.000Z" }),
          ]);
          throw new AgentFsError(0, "NETWORK", "offline again");
        },
      }),
    );
    expect(readOutbox(storage, key).map((e) => [e.id, e.error])).toEqual([
      ["a", "offline again"],
      ["late", "offline"],
    ]);
  });

  test("an entry whose earlier send landed is dropped, not sent again", async () => {
    const landed = entry("a");
    const { storage, key, sent, options } = retrySetup([landed, entry("b")]);
    await retryOutboxEntries(
      options({
        fetchThreads: async () => [thread({ id: "t1", body: "body a" })],
      }),
    );
    expect(sent).toEqual(["body b"]);
    expect(readOutbox(storage, key)).toEqual([]);
  });

  test("the landed-send match needs the same author, target, and a time after the first try", () => {
    const root = entry("a");
    expect(alreadyPosted(root, [thread({ body: "body a" })])).toBe(true);
    // The "/"-prefixed stored path is the same file.
    expect(alreadyPosted(root, [thread({ body: "body a", path: "/comb-qa/notes.md" })])).toBe(true);
    expect(alreadyPosted(root, [thread({ body: "body a", author: "user-2" })])).toBe(false);
    expect(alreadyPosted(root, [thread({ body: "body a", path: "comb-qa/other.md" })])).toBe(false);
    expect(
      alreadyPosted(root, [thread({ body: "body a", createdAt: "2026-09-29T08:00:00.000Z" })]),
    ).toBe(false);

    const reply = entry("r", { params: { parentId: "t1", body: "on it" } });
    const withReply = (author: string) =>
      thread({
        id: "t1",
        author: "user-2",
        replies: [thread({ id: "r1", parentId: "t1", body: "on it", author })],
      });
    expect(alreadyPosted(reply, [withReply("user-1")])).toBe(true);
    expect(alreadyPosted(reply, [withReply("user-2")])).toBe(false);
  });

  test("without the current threads nothing is sent and every entry stays", async () => {
    const { storage, key, sent, options } = retrySetup([entry("a"), entry("b")]);
    await retryOutboxEntries(
      options({
        fetchThreads: async () => {
          throw new AgentFsError(0, "NETWORK", "offline");
        },
      }),
    );
    expect(sent).toEqual([]);
    expect(readOutbox(storage, key).map((e) => [e.id, e.error])).toEqual([
      ["a", "offline"],
      ["b", "offline"],
    ]);
  });

  test("another user's entries are never sent and stay stored", async () => {
    const { storage, key, sent, options } = retrySetup([
      entry("mine"),
      entry("theirs", { userId: "user-2" }),
    ]);
    await retryOutboxEntries(options());
    expect(sent).toEqual(["body mine"]);
    expect(readOutbox(storage, key).map((e) => e.id)).toEqual(["theirs"]);
  });

  test("a per-entry retry sends only that entry", async () => {
    const { storage, key, sent, options } = retrySetup([entry("a"), entry("b")]);
    await retryOutboxEntries(options({ ids: new Set(["b"]) }));
    expect(sent).toEqual(["body b"]);
    expect(readOutbox(storage, key).map((e) => e.id)).toEqual(["a"]);
  });

  test("an entry the page put back mid-retry (pagehide) is not sent by that retry", async () => {
    const { storage, key, sent, inFlight, options } = retrySetup([entry("a"), entry("b")]);
    await retryOutboxEntries(
      options({
        send: async (params) => {
          sent.push(params.body);
          // What `pagehide` does: every claimed entry goes back to storage.
          returnToOutbox(storage, key, [...inFlight.values()]);
          inFlight.clear();
        },
      }),
    );
    expect(sent).toEqual(["body a"]);
    expect(readOutbox(storage, key).map((e) => e.id)).toEqual(["a", "b"]);
  });
});
