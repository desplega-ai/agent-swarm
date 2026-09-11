/**
 * The Claude hook's handling of the SHARED personal CLAUDE.md
 * (`~/.claude/CLAUDE.md`) across concurrent sessions of one agent.
 *
 * Every SessionStart backs the current file up to `.bak` and materializes the
 * DB value into it; every Stop syncs the file back and restores the `.bak`.
 * Sessions of one agent overlap, so what a Stop finds on disk can be:
 *   (a) this session's edit,
 *   (b) this session's untouched materialization,
 *   (c) something a SIBLING session's hook wrote — its materialization or its
 *       `.bak` restore,
 *   (d) this session's own restore from an earlier Stop (Stop can fire more
 *       than once per session).
 * Only (a) is an edit. Syncing (b)–(d) can revert a value the DB already moved
 * past — measured: `claudeMd` edits reverted 8–27 s later, byte-for-byte to the
 * previous version.
 *
 * Two records tell them apart:
 *   - shared: the hash of the LAST content any hook wrote to the file. A file
 *     that still holds exactly that was written by a hook, not edited — (b),
 *     (c), (d) — and is never synced.
 *   - per `session_id`: the hash this session materialized. An edit is sent with
 *     it as the compare-and-set token (`expectedHashes.claudeMd`), so the server
 *     drops the edit if the DB moved since this session read it, and applies it
 *     otherwise — including a deliberate revert to an earlier version.
 *
 * Known limit, unchanged by this module: if a sibling's `.bak` restore lands on
 * disk after this session's edit, the edit is lost from disk (not from the DB).
 */

import {
  CLAUDE_MD_LAST_HOOK_WRITE_PATH,
  CLAUDE_MD_PATH,
  contentSha256,
  type FileReader,
  type ProfilePayload,
} from "./profile-sync.ts";

export interface ClaudeMdSessionPaths {
  /** The shared personal CLAUDE.md. */
  file: string;
  /** Where SessionStart backs up the previous content; Stop restores it. */
  backup: string;
  /** sha256 of the last content a hook wrote to `file`. */
  lastHookWrite: string;
  /** One `<session_id>.json` per session: the hash it materialized. */
  sessionsDir: string;
}

export const DEFAULT_CLAUDE_MD_SESSION_PATHS: ClaudeMdSessionPaths = {
  file: CLAUDE_MD_PATH,
  backup: `${CLAUDE_MD_PATH}.bak`,
  lastHookWrite: CLAUDE_MD_LAST_HOOK_WRITE_PATH,
  sessionsDir: "/tmp/agent-swarm-session-baselines",
};

/** Session baselines are kept after Stop (it can fire twice), so prune old ones. */
const SESSION_BASELINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const readText: FileReader = async (path) => {
  const file = Bun.file(path);
  return (await file.exists()) ? await file.text() : undefined;
};

export function sessionBaselinePath(sessionId: string, sessionsDir: string): string | null {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "");
  return safe ? `${sessionsDir}/${safe}.json` : null;
}

async function recordHookWrite(content: string | null, paths: ClaudeMdSessionPaths): Promise<void> {
  if (content === null) await Bun.file(paths.lastHookWrite).delete();
  else await Bun.write(paths.lastHookWrite, contentSha256(content));
}

async function writeSessionBaseline(
  sessionId: string,
  content: string,
  paths: ClaudeMdSessionPaths,
): Promise<void> {
  const path = sessionBaselinePath(sessionId, paths.sessionsDir);
  if (!path) return;
  await Bun.write(path, JSON.stringify({ claudeMd: contentSha256(content) }));

  const now = Date.now();
  for await (const name of new Bun.Glob("*.json").scan({ cwd: paths.sessionsDir })) {
    const file = Bun.file(`${paths.sessionsDir}/${name}`);
    const info = await file.stat().catch(() => null);
    if (info && now - info.mtimeMs > SESSION_BASELINE_MAX_AGE_MS) {
      await file.delete().catch(() => {});
    }
  }
}

/**
 * SessionStart: back up whatever is on disk, materialize the DB value, and record
 * both the shared last-hook-write and this session's baseline. The two records
 * are best effort — without them the Stop sync degrades to the previous
 * unconditional write, never to a failed session.
 */
export async function materializeClaudeMd(
  content: string,
  sessionId: string | undefined,
  paths: ClaudeMdSessionPaths = DEFAULT_CLAUDE_MD_SESSION_PATHS,
): Promise<void> {
  const current = Bun.file(paths.file);
  if (await current.exists()) await Bun.write(paths.backup, await current.text());
  await Bun.write(paths.file, content); // creates ~/.claude if missing

  await recordHookWrite(content, paths).catch(() => {});
  if (sessionId) await writeSessionBaseline(sessionId, content, paths).catch(() => {});
}

/** Stop: restore the `.bak` (or remove the file if there was none) and record it. */
export async function restoreClaudeMd(
  paths: ClaudeMdSessionPaths = DEFAULT_CLAUDE_MD_SESSION_PATHS,
): Promise<void> {
  const backup = Bun.file(paths.backup);
  if (await backup.exists()) {
    const content = await backup.text();
    await Bun.write(paths.file, content);
    await backup.delete();
    await recordHookWrite(content, paths).catch(() => {});
  } else {
    await Bun.file(paths.file)
      .delete()
      .catch(() => {});
    await recordHookWrite(null, paths).catch(() => {});
  }
}

export interface ClaudeMdSyncState {
  /** Current content of the shared file. */
  content: string;
  /** Hash this session materialized, or null (no `session_id` / no record). */
  sessionBase: string | null;
  /** Hash of the last content any hook wrote to the file, or null. */
  lastHookWrite: string | null;
}

/** Read what the Stop sync needs to decide; missing records come back null. */
export async function readClaudeMdSyncState(
  sessionId: string | undefined,
  paths: ClaudeMdSessionPaths = DEFAULT_CLAUDE_MD_SESSION_PATHS,
  readFile: FileReader = readText,
): Promise<ClaudeMdSyncState | null> {
  const content = await readFile(paths.file);
  if (content === undefined) return null;

  let sessionBase: string | null = null;
  const baselinePath = sessionId ? sessionBaselinePath(sessionId, paths.sessionsDir) : null;
  if (baselinePath) {
    try {
      const hash = (JSON.parse((await readFile(baselinePath)) ?? "null") as { claudeMd?: unknown })
        ?.claudeMd;
      sessionBase = typeof hash === "string" ? hash : null;
    } catch {
      sessionBase = null;
    }
  }
  const lastHookWrite = (await readFile(paths.lastHookWrite))?.trim() || null;
  return { content, sessionBase, lastHookWrite };
}

/**
 * The `session_sync` body for the Stop hook, or null to skip:
 *   - content a hook wrote (last-hook-write) → skip: not an edit;
 *   - no session baseline → the previous unconditional sync;
 *   - unchanged since this session materialized it → skip;
 *   - otherwise an edit → sent with its base as `expectedHashes.claudeMd`.
 */
export function planClaudeMdSync(state: ClaudeMdSyncState): ProfilePayload["body"] | null {
  const { content, sessionBase, lastHookWrite } = state;
  if (!content.trim()) return null;
  const hash = contentSha256(content);
  if (lastHookWrite !== null && hash === lastHookWrite) return null;
  if (sessionBase === null) return { claudeMd: content, changeSource: "session_sync" };
  if (hash === sessionBase) return null;
  return {
    claudeMd: content,
    changeSource: "session_sync",
    expectedHashes: { claudeMd: sessionBase },
  };
}
