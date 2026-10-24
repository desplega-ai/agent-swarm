import { renameSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

/**
 * One-time "keep this turn bounded" note for long Claude worker sessions.
 *
 * The Claude session (CLI adapter or SDK transport) writes the prompt size of
 * its latest main-thread request next to the task file. The PostToolUse hook
 * reads it and, the first time it reaches the threshold, claims a marker file
 * and injects the note. Every failure path means "no note": the hook never
 * blocks a tool call over this.
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
  if (typeof contextTokens !== "number" || !Number.isFinite(contextTokens)) return null;
  if (contextTokens < threshold) return null;
  try {
    await writeFile(contextBoundNoteMarkerPath(taskFilePath), new Date().toISOString(), {
      flag: "wx",
    });
  } catch {
    return null;
  }
  return contextTokens;
}
