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
 * Transitions of the pair (file + record) run under one kernel-held
 * cross-process lock (`src/utils/file-lock.ts`, flock): SessionStart's
 * materialization, the Stop's whole read → sync → restore protocol, and the
 * runner backstop's read + post. Without it a Stop landing between the file
 * write and the record write reads a mismatched pair and can re-create the
 * revert this module exists to prevent. The lock can never be taken from a live
 * holder, so no transition ever runs without it:
 *   - lock busy (or failing) → the transition is skipped, never run unlocked.
 *     A skipped SessionStart leaves the file as it is (whatever is there carries
 *     its own lineage); a skipped Stop pushes and restores nothing.
 *   - no flock on this platform → SessionStart still materializes (unprotected)
 *     but no Stop ever pushes: the DB is never at risk, only the sync of
 *     CLAUDE.md edits is lost there.
 * The record and the sidecar are also written atomically (temp file + rename),
 * and an unreadable record counts as hook-written, never as a reason to push.
 * A write that fails fails closed, the same way: every hook write marks the
 * record pending BEFORE touching the file, and the real lineage replaces the
 * marker after. A pending record makes whatever is on disk hook-written, for
 * the Stop and the runner backstop alike, so:
 *   - the marker cannot be written → the transition is skipped (SessionStart
 *     throws, a Stop restores nothing), as with a busy lock;
 *   - the real lineage cannot replace it → the marker stays: an edit made on
 *     top of that file goes unsynced, it never reverts the DB.
 * A Stop with no `.bak` removes the record only once the file is gone.
 *
 * Known limit: with one `.bak` slot, a third overlapping session overwrites the
 * backup of the first, and a Stop can restore a backup a sibling took (as before
 * this module); both are disk-level only, since every copy carries its lineage.
 */

// `rename` has no Bun equivalent; it is what makes the record writes atomic.
import { rename } from "node:fs/promises";
import { withFileLock } from "../utils/file-lock.ts";
import { scrubSecrets } from "../utils/secret-scrubber.ts";
import {
  CLAUDE_MD_LINEAGE_PATH,
  CLAUDE_MD_LOCK_PATH,
  CLAUDE_MD_PATH,
  CLAUDE_MD_PENDING_RECORD,
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

/**
 * How long each side waits for the lock, both below the Claude Code hook timeout
 * (60 s). SessionStart waits longer: giving up means the session starts with
 * whatever CLAUDE.md is already on disk.
 */
const SESSION_START_LOCK_WAIT_MS = 40_000;
const STOP_LOCK_WAIT_MS = 15_000;

/**
 * Test seam: pause points inside a transition, to force interleavings — or, by
 * throwing, a failure of the step that follows.
 */
export interface ClaudeMdTestPauses {
  afterFileWrite?: () => Promise<void>;
  /** Right before the real lineage replaces the pending marker. */
  beforeRecordCommit?: () => Promise<void>;
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
 * The one way a hook write reaches the file: mark the record pending, run
 * `write` (it puts the content in place and returns its lineage), then replace
 * the marker with that lineage. The marker failing throws before `write` runs;
 * the lineage failing is logged, not thrown: the file is already in place and
 * the marker keeps it unpushable.
 */
async function writeUnderPendingRecord(
  paths: ClaudeMdSessionPaths,
  pauses: ClaudeMdTestPauses,
  write: () => Promise<ClaudeMdLineage>,
): Promise<void> {
  await writeAtomic(paths.record, CLAUDE_MD_PENDING_RECORD);
  const lineage = await write();
  try {
    await pauses.beforeRecordCommit?.();
    await writeAtomic(paths.record, JSON.stringify(lineage));
  } catch (error) {
    console.warn(
      scrubSecrets(`[claude-md] lineage not recorded, the file stays unpushable: ${String(error)}`),
    );
  }
}

/** Delete `path`: already gone is fine, any other failure throws. */
async function deleteIfPresent(path: string): Promise<void> {
  try {
    await Bun.file(path).delete();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Why a transition did not run under the lock; see `FileLockResult`. */
type LockMiss = "busy" | "error" | "unsupported";

function warnLockMiss(step: string, miss: { reason: LockMiss; error?: unknown }): void {
  const detail = miss.error === undefined ? "" : `: ${String(miss.error)}`;
  console.warn(scrubSecrets(`[claude-md] no lock at ${step} (${miss.reason})${detail}`));
}

/** `unsupported`: materialized anyway, without protection (see the module header). */
export type ClaudeMdMaterializeOutcome = "materialized" | LockMiss;

/**
 * SessionStart: under the lock, back up whatever is on disk together with its
 * lineage, then materialize the DB value and record it. Lock busy or failing →
 * nothing is written (the file is left as it is). No flock on this platform →
 * materialized without protection; `stopClaudeMd` then never pushes. Throws,
 * leaving the file and its record as they were, if the record cannot be marked
 * pending.
 */
export async function materializeClaudeMd(
  content: string,
  paths: ClaudeMdSessionPaths = DEFAULT_CLAUDE_MD_SESSION_PATHS,
  options: { testPauses?: ClaudeMdTestPauses; lockWaitMs?: number } = {},
): Promise<ClaudeMdMaterializeOutcome> {
  const pauses = options.testPauses ?? {};
  const locked = await withFileLock(paths.lock, () => materializeUnlocked(content, paths, pauses), {
    waitMs: options.lockWaitMs ?? SESSION_START_LOCK_WAIT_MS,
  });
  if (locked.acquired) return "materialized";
  warnLockMiss("SessionStart", locked);
  if (locked.reason === "unsupported") await materializeUnlocked(content, paths, pauses);
  return locked.reason;
}

async function materializeUnlocked(
  content: string,
  paths: ClaudeMdSessionPaths,
  pauses: ClaudeMdTestPauses,
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
  await writeUnderPendingRecord(paths, pauses, async () => {
    await Bun.write(paths.file, content); // creates ~/.claude if missing
    await pauses.afterFileWrite?.();
    const hash = contentSha256(content);
    return { written: hash, base: hash };
  });
}

/**
 * Restore the `.bak` with its lineage (or remove the file if there was none).
 * Throws, having restored nothing, if the record cannot be marked pending.
 */
async function restoreUnlocked(
  paths: ClaudeMdSessionPaths,
  pauses: ClaudeMdTestPauses,
): Promise<void> {
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
    await writeUnderPendingRecord(paths, pauses, async () => {
      await Bun.write(paths.file, content);
      // Without a matching sidecar (a legacy `.bak`, a failed or stale sidecar)
      // the lineage is unknown: record it as hook-written, the conservative
      // choice (never pushed as an edit).
      return lineage ?? hookWrittenLineage(content);
    });
    // Only after the lineage: a `.bak` that cannot be deleted must not cost a
    // restored edit its lineage. (A leftover `.bak` is restored again, harmlessly.)
    await backup.delete();
    await sidecar.delete().catch(() => {});
  } else {
    // The record goes only once the file is gone: a file left without its
    // record would be sent unconditionally by the next Stop.
    await deleteIfPresent(paths.file);
    await deleteIfPresent(paths.record).catch(() => {});
  }
}

/** A Stop never fails over its restore: it is logged, and the rest of Stop runs. */
async function restoreOrWarn(paths: ClaudeMdSessionPaths, pauses: ClaudeMdTestPauses) {
  await restoreUnlocked(paths, pauses).catch((error: unknown) => {
    console.warn(scrubSecrets(`[claude-md] .bak not restored: ${String(error)}`));
  });
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

/** `unsupported`: the `.bak` was restored, but nothing is ever pushed there. */
export type ClaudeMdStopOutcome = "synced" | "not-an-edit" | LockMiss;

/**
 * Stop: under the lock, decide the sync from what is on disk, run it, then
 * restore the `.bak` — one transition, so no SessionStart can land in between.
 * Lock busy or failing → nothing is pushed or restored (safe: the next
 * SessionStart backs up whatever is there, with its lineage). No flock on this
 * platform → the `.bak` is restored as before, but nothing is ever pushed. A
 * restore that fails is logged, never thrown.
 */
export async function stopClaudeMd(
  sync: (body: ProfilePayload["body"]) => Promise<void>,
  paths: ClaudeMdSessionPaths = DEFAULT_CLAUDE_MD_SESSION_PATHS,
  options: { testPauses?: ClaudeMdTestPauses; lockWaitMs?: number } = {},
): Promise<ClaudeMdStopOutcome> {
  const pauses = options.testPauses ?? {};
  const locked = await withFileLock(
    paths.lock,
    async (): Promise<ClaudeMdStopOutcome> => {
      const state = await readClaudeMdSyncState(paths);
      const body = state ? planClaudeMdSync(state) : null;
      if (body) {
        await sync(body).catch((error: unknown) => {
          console.warn(scrubSecrets(`[claude-md] sync failed: ${String(error)}`));
        });
      }
      await restoreOrWarn(paths, pauses);
      return body ? "synced" : "not-an-edit";
    },
    { waitMs: options.lockWaitMs ?? STOP_LOCK_WAIT_MS },
  );
  if (locked.acquired) return locked.value;
  warnLockMiss("Stop", locked);
  if (locked.reason === "unsupported") await restoreOrWarn(paths, pauses);
  return locked.reason;
}
