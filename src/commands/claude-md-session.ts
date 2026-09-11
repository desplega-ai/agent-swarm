/**
 * The Claude hook's handling of the SHARED personal CLAUDE.md
 * (`~/.claude/CLAUDE.md`) across concurrent sessions of one agent.
 *
 * Every SessionStart backs the current file up to `.bak` and materializes the
 * DB value into it; every Stop syncs the file back and restores the `.bak`.
 * Sessions of one agent overlap, so what a Stop finds on disk can be an agent's
 * edit, or content a hook wrote — this session's or a sibling's materialization,
 * or a `.bak` restore (Stop can fire more than once). Syncing hook-written
 * content can revert a value the DB already moved past — measured: `claudeMd`
 * edits reverted 8–27 s later, byte-for-byte to the previous version.
 *
 * So the hook keeps a LINEAGE record for the file, rewritten on every hook write:
 *   - `written`: hash of the content the hook itself put there, or null when it
 *     restored an agent's edit. A file that still hashes to it is not an edit
 *     and is never synced.
 *   - `base`: hash of the DB value that content derives from. An edit is sent
 *     with it as the compare-and-set token (`expectedHashes.claudeMd`): the
 *     server applies it if the DB is still at that value — including a
 *     deliberate revert to an earlier version — and drops it otherwise.
 * The `.bak` carries the same two facts in a sidecar, so restoring an agent's
 * unsynced edit that a sibling's SessionStart had backed up brings back an edit
 * (still synced, against its own base), not something a hook wrote.
 *
 * Every transition of the pair (file + record) runs under one cross-process
 * lock (`file-lock.ts`): SessionStart's materialization, and the Stop's whole
 * read → sync → restore protocol. Without it a Stop landing between the file
 * write and the record write reads a mismatched pair and can re-create the
 * revert this module exists to prevent. The record and the sidecar are also
 * written atomically (temp file + rename), and an unreadable record counts as
 * hook-written, never as a reason to push.
 *
 * Known limit: with one `.bak` slot, a third overlapping session overwrites the
 * backup of the first (as before this module).
 */

// `rename` has no Bun equivalent; it is what makes the record writes atomic.
import { rename } from "node:fs/promises";
import { type FileLockOptions, withFileLock } from "./file-lock.ts";
import {
  CLAUDE_MD_LINEAGE_PATH,
  CLAUDE_MD_LOCK_PATH,
  CLAUDE_MD_PATH,
  type ClaudeMdLineage,
  claudeMdLineageOf,
  contentSha256,
  effectiveClaudeMdLineage,
  type FileReader,
  hookWrittenLineage,
  type ProfilePayload,
  parseClaudeMdLineage,
  planClaudeMdSync,
} from "./profile-sync.ts";

export { planClaudeMdSync };

export interface ClaudeMdSessionPaths {
  /** The shared personal CLAUDE.md. */
  file: string;
  /** Where SessionStart backs up the previous content; Stop restores it. */
  backup: string;
  /** Lineage record of the content the hook last wrote to `file`. */
  record: string;
  /** Cross-process lock for every transition of `file` + `record`. */
  lock: string;
}

const readText: FileReader = async (path) => {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : undefined;
};

export const DEFAULT_CLAUDE_MD_SESSION_PATHS: ClaudeMdSessionPaths = {
  file: CLAUDE_MD_PATH,
  backup: `${CLAUDE_MD_PATH}.bak`,
  record: CLAUDE_MD_LINEAGE_PATH,
  lock: CLAUDE_MD_LOCK_PATH,
};

/** Test seam: pause points inside a transition, to force interleavings. */
export interface ClaudeMdTransitionHooks {
  afterFileWrite?: () => Promise<void>;
}

/**
 * Write via a temp file in the same directory plus `rename`: readers see the old
 * content or the new one, never a partial write. `rename` also replaces a
 * symlink at `path` instead of writing through it.
 */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await Bun.write(tmp, data);
  try {
    await rename(tmp, path);
  } catch (error) {
    await Bun.file(tmp)
      .delete()
      .catch(() => {});
    throw error;
  }
}

/**
 * SessionStart: under the lock, back up whatever is on disk together with its
 * lineage, then materialize the DB value and record it. If the lock stays busy
 * the session still gets its CLAUDE.md (unlocked, with a warning): an agent
 * without its instructions is worse than the narrow race the lock closes.
 */
export async function materializeClaudeMd(
  content: string,
  paths: ClaudeMdSessionPaths = DEFAULT_CLAUDE_MD_SESSION_PATHS,
  options: { hooks?: ClaudeMdTransitionHooks; lock?: FileLockOptions } = {},
): Promise<void> {
  const hooks = options.hooks ?? {};
  const locked = await withFileLock(
    paths.lock,
    () => materializeUnlocked(content, paths, hooks),
    options.lock,
  );
  if (!locked.acquired) {
    console.warn("[claude-md] lock busy at SessionStart — materializing without it");
    await materializeUnlocked(content, paths, hooks);
  }
}

async function materializeUnlocked(
  content: string,
  paths: ClaudeMdSessionPaths,
  hooks: ClaudeMdTransitionHooks,
): Promise<void> {
  const current = Bun.file(paths.file);
  if (await current.exists()) {
    const existing = await current.text();
    const record = effectiveClaudeMdLineage(
      await readText(paths.record).catch(() => undefined),
      existing,
    );
    // With a record, anything but the hook's own write is an agent's unsynced
    // edit. Without one (the file predates the hook, e.g. the user's own) its
    // origin is unknown: treat it as hook-written, never to be pushed.
    const lineage = record ? claudeMdLineageOf(existing, record) : hookWrittenLineage(existing);
    await Bun.write(paths.backup, existing);
    // `of` pins the sidecar to this exact backup: a stale sidecar left by an
    // earlier overlap must not describe a different `.bak`.
    const sidecar = { ...lineage, of: contentSha256(existing) };
    await writeAtomic(`${paths.backup}.lineage`, JSON.stringify(sidecar)).catch(() => {});
  }
  await Bun.write(paths.file, content); // creates ~/.claude if missing
  await hooks.afterFileWrite?.();

  const hash = contentSha256(content);
  await writeAtomic(paths.record, JSON.stringify({ written: hash, base: hash })).catch(() => {});
}

/** Restore the `.bak` with its lineage (or remove the file if there was none). */
async function restoreUnlocked(paths: ClaudeMdSessionPaths): Promise<void> {
  const backup = Bun.file(paths.backup);
  const sidecar = Bun.file(`${paths.backup}.lineage`);
  if (await backup.exists()) {
    const content = await backup.text();
    const raw = (await sidecar.exists()) ? await sidecar.text() : undefined;
    let lineage: ClaudeMdLineage | null = null;
    try {
      const pinnedTo = raw ? (JSON.parse(raw) as { of?: unknown }).of : undefined;
      if (pinnedTo === contentSha256(content)) lineage = parseClaudeMdLineage(raw);
    } catch {
      lineage = null; // corrupt sidecar: unknown lineage
    }
    await Bun.write(paths.file, content);
    await backup.delete();
    await sidecar.delete().catch(() => {});
    // Without a matching sidecar (a legacy `.bak`, a failed or stale sidecar) the
    // lineage is unknown: record it as hook-written, the conservative choice
    // (never pushed as an edit).
    const record = lineage ?? hookWrittenLineage(content);
    await writeAtomic(paths.record, JSON.stringify(record)).catch(() => {});
  } else {
    await Bun.file(paths.file)
      .delete()
      .catch(() => {});
    await Bun.file(paths.record)
      .delete()
      .catch(() => {});
  }
}

export interface ClaudeMdSyncState {
  /** Current content of the shared file. */
  content: string;
  /** Lineage record of the last hook write, or null if there is none. */
  record: ClaudeMdLineage | null;
}

/** Read what the Stop sync needs to decide; null when the file does not exist. */
export async function readClaudeMdSyncState(
  paths: ClaudeMdSessionPaths = DEFAULT_CLAUDE_MD_SESSION_PATHS,
  readFile: FileReader = readText,
): Promise<ClaudeMdSyncState | null> {
  const content = await readFile(paths.file);
  if (content === undefined) return null;
  return { content, record: effectiveClaudeMdLineage(await readFile(paths.record), content) };
}

export type ClaudeMdStopOutcome = "synced" | "not-an-edit" | "busy";

/**
 * Stop: under the lock, decide the sync from what is on disk, run it, then
 * restore the `.bak` — one transition, so no SessionStart can land in between.
 * If the lock stays busy nothing is pushed or restored: that is safe, the next
 * SessionStart backs up whatever is there together with its lineage.
 */
export async function stopClaudeMd(
  sync: (body: ProfilePayload["body"]) => Promise<void>,
  paths: ClaudeMdSessionPaths = DEFAULT_CLAUDE_MD_SESSION_PATHS,
  options: { lock?: FileLockOptions } = {},
): Promise<ClaudeMdStopOutcome> {
  const locked = await withFileLock(
    paths.lock,
    async (): Promise<ClaudeMdStopOutcome> => {
      const state = await readClaudeMdSyncState(paths);
      const body = state ? planClaudeMdSync(state) : null;
      if (body) {
        await sync(body).catch((error: unknown) => {
          console.warn(`[claude-md] sync failed: ${String(error)}`);
        });
      }
      await restoreUnlocked(paths);
      return body ? "synced" : "not-an-edit";
    },
    options.lock,
  );
  if (!locked.acquired) {
    console.warn("[claude-md] lock busy at Stop — CLAUDE.md sync and restore skipped");
    return "busy";
  }
  return locked.value;
}
