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
 * Known limits: the file write and the record write are two steps with no lock
 * between hook processes, so a Stop interleaved within that window can misjudge
 * one write; and with one `.bak` slot, a third overlapping session overwrites
 * the backup of the first (as before this module).
 */

import {
  CLAUDE_MD_LAST_HOOK_WRITE_PATH,
  CLAUDE_MD_PATH,
  type ClaudeMdLineage,
  claudeMdLineageOf,
  contentSha256,
  type FileReader,
  parseClaudeMdLineage,
} from "./profile-sync.ts";

export { planClaudeMdSync } from "./profile-sync.ts";

export interface ClaudeMdSessionPaths {
  /** The shared personal CLAUDE.md. */
  file: string;
  /** Where SessionStart backs up the previous content; Stop restores it. */
  backup: string;
  /** Lineage record of the content the hook last wrote to `file`. */
  record: string;
}

const readText: FileReader = async (path) => {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : undefined;
};

export const DEFAULT_CLAUDE_MD_SESSION_PATHS: ClaudeMdSessionPaths = {
  file: CLAUDE_MD_PATH,
  backup: `${CLAUDE_MD_PATH}.bak`,
  record: CLAUDE_MD_LAST_HOOK_WRITE_PATH,
};

/**
 * SessionStart: back up whatever is on disk together with its lineage, then
 * materialize the DB value and record it. The record is best effort — without it
 * the Stop sync degrades to the previous unconditional write, never to a failure.
 */
export async function materializeClaudeMd(
  content: string,
  paths: ClaudeMdSessionPaths = DEFAULT_CLAUDE_MD_SESSION_PATHS,
): Promise<void> {
  const current = Bun.file(paths.file);
  if (await current.exists()) {
    const existing = await current.text();
    const record = await readClaudeMdLineage(paths.record).catch(() => null);
    // With a record, anything but the hook's own write is an agent's unsynced
    // edit. Without one (the file predates the hook, e.g. the user's own) its
    // origin is unknown: treat it as hook-written, never to be pushed.
    const lineage = record
      ? claudeMdLineageOf(existing, record)
      : { written: contentSha256(existing), base: null };
    await Bun.write(paths.backup, existing);
    await Bun.write(`${paths.backup}.lineage`, JSON.stringify(lineage)).catch(() => {});
  }
  await Bun.write(paths.file, content); // creates ~/.claude if missing

  const hash = contentSha256(content);
  await Bun.write(paths.record, JSON.stringify({ written: hash, base: hash })).catch(() => {});
}

/** Stop: restore the `.bak` with its lineage (or remove the file if there was none). */
export async function restoreClaudeMd(
  paths: ClaudeMdSessionPaths = DEFAULT_CLAUDE_MD_SESSION_PATHS,
): Promise<void> {
  const backup = Bun.file(paths.backup);
  const sidecar = Bun.file(`${paths.backup}.lineage`);
  if (await backup.exists()) {
    const content = await backup.text();
    const lineage = parseClaudeMdLineage(
      (await sidecar.exists()) ? await sidecar.text() : undefined,
    );
    await Bun.write(paths.file, content);
    await backup.delete();
    await sidecar.delete().catch(() => {});
    // Without a sidecar (a `.bak` from before this module) the lineage is unknown:
    // record it as hook-written, the conservative choice (never pushed as an edit).
    const record = lineage ?? { written: contentSha256(content), base: null };
    await Bun.write(paths.record, JSON.stringify(record)).catch(() => {});
  } else {
    await Bun.file(paths.file)
      .delete()
      .catch(() => {});
    await Bun.file(paths.record)
      .delete()
      .catch(() => {});
  }
}

export async function readClaudeMdLineage(
  path: string = CLAUDE_MD_LAST_HOOK_WRITE_PATH,
  readFile: FileReader = readText,
): Promise<ClaudeMdLineage | null> {
  return parseClaudeMdLineage(await readFile(path));
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
  return { content, record: await readClaudeMdLineage(paths.record, readFile) };
}
