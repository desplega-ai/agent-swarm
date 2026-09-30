import { describe, expect, test } from "bun:test";
import { AgentFsError } from "../agent-fs/client";
import type { CommentAddParams } from "../agent-fs/types";
import {
  addToOutbox,
  anchorKeyOf,
  type CommentScope,
  DRAFT_MAX_AGE_MS,
  type DraftStorage,
  discardFromOutbox,
  draftStorageKey,
  isRetryableSendError,
  type OutboxEntry,
  outboxStorageKey,
  readDraft,
  readOutbox,
  retryOutbox,
  writeDraft,
  writeOutbox,
} from "./drafts";

function memoryStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const SCOPE: CommentScope = {
  apiUrl: "http://localhost:3013",
  endpoint: "http://localhost:7433",
  orgId: "org-1",
  driveId: "drive-1",
  path: "/comb-qa/notes.md",
};

describe("drafts", () => {
  test("the key is namespaced by swarm, agent-fs server, drive, file, and composer", () => {
    expect(draftStorageKey(SCOPE, "file")).toBe(
      "swarm:v1:http://localhost:3013:comb:draft:http://localhost:7433:org-1/drive-1:/comb-qa/notes.md:file",
    );
    expect(draftStorageKey(SCOPE, "parent-1")).toEndWith(":/comb-qa/notes.md:parent-1");
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
});

describe("outbox", () => {
  const params: CommentAddParams = { path: "comb-qa/notes.md", body: "Tighten this" };
  const now = new Date("2026-09-30T08:00:00Z");

  test("add, read back, and discard", () => {
    const storage = memoryStorage();
    const key = outboxStorageKey(SCOPE);
    const entries = addToOutbox([], { id: "a", params, error: "offline", now });
    writeOutbox(storage, key, entries);
    expect(readOutbox(storage, key)).toEqual([
      { id: "a", params, createdAt: "2026-09-30T08:00:00.000Z", error: "offline" },
    ]);
    writeOutbox(storage, key, discardFromOutbox(readOutbox(storage, key), "a"));
    expect(readOutbox(storage, key)).toEqual([]);
    expect(storage.map.has(key)).toBe(false);
  });

  test("retry keeps only the entries that fail again, with the new error", async () => {
    let entries: OutboxEntry[] = [];
    entries = addToOutbox(entries, { id: "a", params, error: "offline", now });
    entries = addToOutbox(entries, {
      id: "b",
      params: { ...params, body: "second" },
      error: "offline",
      now,
    });
    const sent: string[] = [];
    const left = await retryOutbox(entries, async (p) => {
      if (p.body === "second") throw new AgentFsError(503, "UNAVAILABLE", "still down");
      sent.push(p.body);
    });
    expect(sent).toEqual(["Tighten this"]);
    expect(left.map((entry) => [entry.id, entry.error])).toEqual([["b", "still down"]]);
  });

  test("only network errors and 5xx go to the outbox", () => {
    expect(isRetryableSendError(new AgentFsError(0, "NETWORK", "offline"))).toBe(true);
    expect(isRetryableSendError(new AgentFsError(502, "BAD_GATEWAY", "down"))).toBe(true);
    expect(isRetryableSendError(new AgentFsError(400, "VALIDATION", "bad"))).toBe(false);
    expect(isRetryableSendError(new AgentFsError(403, "FORBIDDEN", "viewer"))).toBe(false);
  });

  test("an unreadable outbox reads as empty", () => {
    const storage = memoryStorage();
    storage.setItem("k", "{not json");
    expect(readOutbox(storage, "k")).toEqual([]);
    storage.setItem("k", JSON.stringify([{ id: 1 }]));
    expect(readOutbox(storage, "k")).toEqual([]);
  });
});
