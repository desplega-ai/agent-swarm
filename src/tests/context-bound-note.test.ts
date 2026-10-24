import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_BOUND_NOTE_DEFAULT_TOKENS,
  claimContextBoundNote,
  contextBoundNoteThreshold,
  contextStatePath,
  createContextBoundNote,
  recordContextState,
} from "../hooks/context-bound-note";
import { renderContextBoundNote } from "../prompts/context-bound-note";
import { normalizeClaudeMessage } from "../providers/claude-session-events";

let dir: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "context-bound-note-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A fresh task file path with `contextTokens` recorded next to it. */
function taskFileWith(contextTokens?: number): string {
  const taskFile = join(dir, `task-${++n}.json`);
  if (contextTokens !== undefined) recordContextState(taskFile, contextTokens);
  return taskFile;
}

describe("contextBoundNoteThreshold", () => {
  test("defaults to 200k when unset, blank or invalid", () => {
    expect(contextBoundNoteThreshold({})).toBe(CONTEXT_BOUND_NOTE_DEFAULT_TOKENS);
    expect(contextBoundNoteThreshold({ CONTEXT_BOUND_NOTE_TOKENS: " " })).toBe(200_000);
    expect(contextBoundNoteThreshold({ CONTEXT_BOUND_NOTE_TOKENS: "-5" })).toBe(200_000);
    expect(contextBoundNoteThreshold({ CONTEXT_BOUND_NOTE_TOKENS: "lots" })).toBe(200_000);
  });

  test("reads an override, including 0", () => {
    expect(contextBoundNoteThreshold({ CONTEXT_BOUND_NOTE_TOKENS: "150000" })).toBe(150_000);
    expect(contextBoundNoteThreshold({ CONTEXT_BOUND_NOTE_TOKENS: "0" })).toBe(0);
  });
});

describe("claimContextBoundNote", () => {
  test("fires once at the threshold, not again on later calls", async () => {
    const taskFile = taskFileWith(200_000);
    expect(await claimContextBoundNote(taskFile, 200_000)).toBe(200_000);
    expect(await claimContextBoundNote(taskFile, 200_000)).toBeNull();
    recordContextState(taskFile, 400_000);
    expect(await claimContextBoundNote(taskFile, 200_000)).toBeNull();
  });

  test("concurrent hooks fire the note once", async () => {
    const taskFile = taskFileWith(300_000);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimContextBoundNote(taskFile, 200_000)),
    );
    expect(results.filter((r) => r !== null)).toEqual([300_000]);
  });

  test("no-op below the threshold, then fires once it is crossed", async () => {
    const taskFile = taskFileWith(199_999);
    expect(await claimContextBoundNote(taskFile, 200_000)).toBeNull();
    recordContextState(taskFile, 210_000);
    expect(await claimContextBoundNote(taskFile, 200_000)).toBe(210_000);
  });

  test("disabled at 0", async () => {
    expect(await claimContextBoundNote(taskFileWith(900_000), 0)).toBeNull();
  });

  test("fails open on missing task file, missing state or corrupt state", async () => {
    expect(await claimContextBoundNote(undefined, 200_000)).toBeNull();
    expect(await claimContextBoundNote(taskFileWith(), 200_000)).toBeNull();

    const corrupt = taskFileWith();
    await Bun.write(contextStatePath(corrupt), "{not json");
    expect(await claimContextBoundNote(corrupt, 200_000)).toBeNull();

    const wrongShape = taskFileWith();
    await Bun.write(contextStatePath(wrongShape), JSON.stringify({ contextTokens: "300000" }));
    expect(await claimContextBoundNote(wrongShape, 200_000)).toBeNull();
  });

  test("fails open when the marker cannot be written", async () => {
    const taskFile = taskFileWith(300_000);
    const writeFile = spyOn(fsPromises, "writeFile").mockRejectedValue(
      Object.assign(new Error("EIO: i/o error"), { code: "EIO" }),
    );
    try {
      expect(await claimContextBoundNote(taskFile, 200_000)).toBeNull();
      expect(writeFile).toHaveBeenCalledTimes(1);
    } finally {
      writeFile.mockRestore();
    }
  });
});

describe("createContextBoundNote", () => {
  function observer(threshold: number, inject: (note: string) => unknown = () => {}) {
    const notes: string[] = [];
    const observe = createContextBoundNote({
      threshold,
      inject: (note) => {
        notes.push(note);
        return inject(note);
      },
    });
    return { observe, notes };
  }

  test("fires once at the threshold, not again on later requests", async () => {
    const { observe, notes } = observer(200_000);
    await observe(200_000);
    await observe(400_000);
    expect(notes).toEqual([await renderContextBoundNote(200_000)]);
  });

  test("no-op below the threshold, then fires once it is crossed", async () => {
    const { observe, notes } = observer(200_000);
    await observe(199_999);
    expect(notes).toEqual([]);
    await observe(210_000);
    expect(notes).toEqual([await renderContextBoundNote(210_000)]);
  });

  test("disabled at 0", async () => {
    const { observe, notes } = observer(0);
    await observe(900_000);
    expect(notes).toEqual([]);
  });

  test("fails open on missing or corrupt sizes", async () => {
    const { observe, notes } = observer(200_000);
    await observe(undefined);
    await observe(Number.NaN);
    await observe(Number.POSITIVE_INFINITY);
    await observe("300000" as unknown as number);
    expect(notes).toEqual([]);
  });

  test("never rejects when injection fails, and does not retry", async () => {
    const { observe, notes } = observer(200_000, () => Promise.reject(new Error("closed")));
    await expect(observe(300_000)).resolves.toBeUndefined();
    await observe(300_000);
    expect(notes).toHaveLength(1);
  });
});

describe("renderContextBoundNote", () => {
  test("renders the code default with a formatted token count", async () => {
    expect(await renderContextBoundNote(213_456)).toBe(
      "Context is 213,456 tokens. Keep this task bounded: finish the current step, store-progress, and complete or defer instead of starting new exploration.",
    );
  });
});

describe("normalizeClaudeMessage requestContextTokens", () => {
  const state = {
    taskId: "task-fixture",
    agentId: "agent-fixture",
    model: "claude-opus-5-5",
    contextWindowSize: 1_000_000,
    transport: "cli" as const,
  };
  const usage = {
    input_tokens: 10,
    cache_read_input_tokens: 180_000,
    cache_creation_input_tokens: 25_000,
    output_tokens: 4_000,
  };

  test("is input + cache read + cache write of a main-thread request", () => {
    const normalized = normalizeClaudeMessage(
      { type: "assistant", message: { content: [], usage } },
      state,
    );
    expect(normalized.requestContextTokens).toBe(205_010);
  });

  test("is unset for subagent messages", () => {
    const normalized = normalizeClaudeMessage(
      { type: "assistant", parent_tool_use_id: "toolu_1", message: { content: [], usage } },
      state,
    );
    expect(normalized.requestContextTokens).toBeUndefined();
  });
});
