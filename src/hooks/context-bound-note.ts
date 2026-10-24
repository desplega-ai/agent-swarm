import { renameSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { renderContextBoundNote } from "../prompts/context-bound-note";

/**
 * One-time "keep this turn bounded" note for long worker sessions, on every
 * harness.
 *
 * This module owns the threshold, the once-per-task claim and the rendering.
 * A harness supplies only two things: the prompt size of its latest
 * main-thread request (input + cache read + cache write tokens) and a way to
 * put text in front of the model mid-session.
 *
 * - Claude: the session writes the size next to the task file
 *   (`recordContextState`); the PostToolUse hook claims a marker file
 *   (`claimContextBoundNote`) and returns the note as tool context.
 * - In-process harnesses (codex, pi, opencode, amp, claude-managed): the session
 *   feeds each request's size to `createContextBoundNote`, which injects the
 *   note through the harness's own mid-turn input, and only while that input
 *   still lands inside the current turn.
 *
 * Every failure path means "no note": nothing here throws into a session or
 * blocks a tool call.
 */

export const CONTEXT_BOUND_NOTE_DEFAULT_TOKENS = 200_000;

/** Threshold from `CONTEXT_BOUND_NOTE_TOKENS`. 0 disables; unset or invalid uses the default. */
export function contextBoundNoteThreshold(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.CONTEXT_BOUND_NOTE_TOKENS?.trim();
  if (!raw) return CONTEXT_BOUND_NOTE_DEFAULT_TOKENS;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
    return CONTEXT_BOUND_NOTE_DEFAULT_TOKENS;
  }
  return parsed;
}

/** True when a valid token count reaches an enabled (> 0) threshold. */
function reachesThreshold(contextTokens: unknown, threshold: number): contextTokens is number {
  return (
    threshold > 0 &&
    typeof contextTokens === "number" &&
    Number.isFinite(contextTokens) &&
    contextTokens >= threshold
  );
}

/** Render the note and hand it to `inject`. Fails open. */
async function deliverContextBoundNote(
  contextTokens: number,
  inject: (note: string) => unknown,
): Promise<void> {
  try {
    const note = await renderContextBoundNote(contextTokens);
    if (note) await inject(note);
  } catch {
    // Fail open.
  }
}

export function contextStatePath(taskFilePath: string): string {
  return `${taskFilePath}.context.json`;
}

export function contextBoundNoteMarkerPath(taskFilePath: string): string {
  return `${taskFilePath}.bound-note`;
}

/**
 * Record the latest request's context size for the hook. Synchronous so
 * writes land in stream order; tmp + rename so the hook never reads a partial
 * file. Errors are swallowed: a missing state file only means no note.
 */
export function recordContextState(taskFilePath: string, contextTokens: number): void {
  const path = contextStatePath(taskFilePath);
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ contextTokens, updatedAt: new Date().toISOString() }));
    renameSync(tmp, path);
  } catch {
    // Fail open.
  }
}

/**
 * Returns the context size when the note should fire now, else null. Fires at
 * most once per task file: the marker is created with `wx`, so a second call
 * (or a concurrent hook) loses the race and gets null.
 */
export async function claimContextBoundNote(
  taskFilePath: string | undefined,
  threshold: number,
): Promise<number | null> {
  if (!taskFilePath || threshold <= 0) return null;
  let contextTokens: unknown;
  try {
    const state = JSON.parse(await readFile(contextStatePath(taskFilePath), "utf8")) as {
      contextTokens?: unknown;
    };
    contextTokens = state?.contextTokens;
  } catch {
    return null;
  }
  if (!reachesThreshold(contextTokens, threshold)) return null;
  try {
    await writeFile(contextBoundNoteMarkerPath(taskFilePath), new Date().toISOString(), {
      flag: "wx",
    });
  } catch {
    return null;
  }
  return contextTokens;
}

/** Claude PostToolUse path: claim from the task file, then hand the note to `inject`. */
export async function injectClaimedContextBoundNote(
  taskFilePath: string | undefined,
  threshold: number,
  inject: (note: string) => unknown,
): Promise<void> {
  const contextTokens = await claimContextBoundNote(taskFilePath, threshold).catch(() => null);
  if (contextTokens !== null) await deliverContextBoundNote(contextTokens, inject);
}

/**
 * In-process path. Returns an observer the session calls with each
 * main-thread request's prompt size. The first size at or above `threshold`
 * claims the note for this session (one session runs one task) and renders
 * it; later sizes are ignored. The returned promise never rejects.
 *
 * Rendering is async (HTTP on workers), so the session may have moved on by
 * the time the note is ready. `canDeliver` decides then: true injects it;
 * false holds it, and each later call retries the held note instead of
 * rendering a new one. A session that settles, aborts or ends its last turn
 * first never gets it.
 */
export function createContextBoundNote(options: {
  threshold: number;
  inject: (note: string) => unknown;
  /** True while a note injected now reaches the model inside the current turn. */
  canDeliver: () => boolean;
}): (contextTokens: number | undefined) => Promise<void> {
  let state: "idle" | "rendering" | "held" | "done" = "idle";
  let held = "";
  const tryDeliver = async (note: string): Promise<void> => {
    try {
      if (!options.canDeliver()) {
        held = note;
        state = "held";
        return;
      }
      state = "done";
      await options.inject(note);
    } catch {
      // Fail open.
    }
  };
  return async (contextTokens) => {
    if (state === "held") return tryDeliver(held);
    if (state !== "idle" || !reachesThreshold(contextTokens, options.threshold)) return;
    state = "rendering";
    let note = "";
    try {
      note = await renderContextBoundNote(contextTokens);
    } catch {
      // Fail open.
    }
    if (!note) {
      state = "done";
      return;
    }
    await tryDeliver(note);
  };
}
