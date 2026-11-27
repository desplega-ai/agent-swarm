import { describe, expect, test } from "bun:test";
import type { ApprovalQuestion } from "../api/types";
import {
  approvalDraftKey,
  clearApprovalDrafts,
  readApprovalDraft,
  writeApprovalDraft,
} from "./approval-drafts";
import { DRAFT_MAX_AGE_MS } from "./comb/drafts";

function memoryStorage() {
  const items = new Map<string, string>();
  return {
    items,
    get length() {
      return items.size;
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

const API = "http://swarm.test";
const NOW = 1_800_000_000_000;
const questions: ApprovalQuestion[] = [
  { id: "go", type: "approval", label: "Ship it?" },
  { id: "why", type: "text", label: "Why?" },
  { id: "token", type: "config", label: "Token", config: { key: "TOKEN", scope: "global" } },
];

describe("approval drafts", () => {
  test("the key changes with the question set, not with a re-fetch", () => {
    const key = approvalDraftKey(API, "req-1", questions);
    expect(approvalDraftKey(API, "req-1", structuredClone(questions))).toBe(key);
    expect(approvalDraftKey(API, "req-1", [{ ...questions[0], label: "Ship now?" }])).not.toBe(key);
    expect(approvalDraftKey(API, "req-2", questions)).not.toBe(key);
  });

  test("round-trips answers, never stores a config answer", () => {
    const storage = memoryStorage();
    const key = approvalDraftKey(API, "req-1", questions);
    writeApprovalDraft(
      storage,
      key,
      questions,
      { go: { approved: true }, why: "fine", token: { action: "set", value: "s3cret" }, gone: 1 },
      NOW,
    );
    expect(storage.items.get(key)).not.toContain("s3cret");
    expect(readApprovalDraft(storage, key, questions, NOW)).toEqual({
      go: { approved: true },
      why: "fine",
    });
  });

  // The create API and MCP accept duplicate question ids, so a text and a config
  // question can share one response slot. That slot holds the config answer.
  const notes: ApprovalQuestion = { id: "same", type: "text", label: "Notes" };
  const secret: ApprovalQuestion = {
    id: "same",
    type: "config",
    label: "Token",
    config: { key: "TOKEN", scope: "global" },
  };
  const go: ApprovalQuestion = { id: "go", type: "approval", label: "Ship it?" };
  for (const [order, shared] of [
    ["text first", [notes, secret, go]],
    ["config first", [secret, notes, go]],
  ] as const) {
    test(`an id shared with a config question is never stored or restored (${order})`, () => {
      const storage = memoryStorage();
      const set = [...shared];
      const key = approvalDraftKey(API, "req-1", set);
      writeApprovalDraft(
        storage,
        key,
        set,
        { same: { action: "set", value: "SECRET" }, go: { approved: true } },
        NOW,
      );
      expect(storage.items.get(key)).not.toContain("SECRET");
      expect(readApprovalDraft(storage, key, set, NOW)).toEqual({ go: { approved: true } });
      // A draft written before this guard still never restores the shared slot.
      storage.setItem(
        key,
        JSON.stringify({
          text: JSON.stringify({
            same: { action: "set", value: "SECRET" },
            go: { approved: true },
          }),
          savedAt: NOW,
        }),
      );
      expect(readApprovalDraft(storage, key, set, NOW)).toEqual({ go: { approved: true } });
    });
  }

  test("a changed question set ignores the old draft", () => {
    const storage = memoryStorage();
    writeApprovalDraft(
      storage,
      approvalDraftKey(API, "req-1", questions),
      questions,
      { why: "x" },
      NOW,
    );
    const changed = [
      ...questions,
      { id: "more", type: "text", label: "More?" } as ApprovalQuestion,
    ];
    expect(
      readApprovalDraft(storage, approvalDraftKey(API, "req-1", changed), changed, NOW),
    ).toEqual({});
  });

  test("an expired, empty or unreadable draft reads as nothing", () => {
    const storage = memoryStorage();
    const key = approvalDraftKey(API, "req-1", questions);
    writeApprovalDraft(storage, key, questions, { why: "x" }, NOW);
    expect(readApprovalDraft(storage, key, questions, NOW + DRAFT_MAX_AGE_MS + 1)).toEqual({});
    writeApprovalDraft(storage, key, questions, { token: { action: "skip" } }, NOW);
    expect(storage.items.has(key)).toBe(false);
    storage.setItem(key, JSON.stringify({ text: "[1]", savedAt: NOW }));
    expect(readApprovalDraft(storage, key, questions, NOW)).toEqual({});
    expect(readApprovalDraft(null, key, questions, NOW)).toEqual({});
  });

  test("clear drops every draft of the request, under any question set, and no other", () => {
    const storage = memoryStorage();
    const other = approvalDraftKey(API, "req-10", questions);
    writeApprovalDraft(
      storage,
      approvalDraftKey(API, "req-1", questions),
      questions,
      { why: "a" },
      NOW,
    );
    writeApprovalDraft(
      storage,
      approvalDraftKey(API, "req-1", [questions[1]]),
      [questions[1]],
      { why: "b" },
      NOW,
    );
    writeApprovalDraft(storage, other, questions, { why: "c" }, NOW);
    clearApprovalDrafts(storage, API, "req-1");
    expect([...storage.items.keys()]).toEqual([other]);
  });

  test("a throwing storage loses the draft, never the form", () => {
    const broken = {
      length: 1,
      key: () => {
        throw new Error("blocked");
      },
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    const key = approvalDraftKey(API, "req-1", questions);
    expect(() => writeApprovalDraft(broken, key, questions, { why: "x" }, NOW)).not.toThrow();
    expect(readApprovalDraft(broken, key, questions, NOW)).toEqual({});
    expect(() => clearApprovalDrafts(broken, API, "req-1")).not.toThrow();
  });
});
