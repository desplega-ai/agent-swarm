/**
 * Harness-agnostic FS → DB profile sync (worker-side, HTTP-only).
 *
 * Persists an agent's self-editable identity / config files back to the API:
 *   - SOUL.md / IDENTITY.md / TOOLS.md / HEARTBEAT.md  (bundled identity POST)
 *   - ~/.claude/CLAUDE.md                              (claude POST)
 *   - /workspace/start-up.sh (agent-managed section)   (setup POST)
 *
 * This mirrors the per-session sync that the Claude plugin hooks
 * (`src/hooks/hook.ts`) and the pi extension (`src/providers/pi-mono-extension.ts`)
 * already perform, but lifted into a single shared module the runner can call
 * at session end for ANY `hasLocalEnvironment` harness (claude, pi, codex,
 * opencode). Before this module, codex/opencode had no sync path at all and
 * pi's path could silently not-fire (2026-06-01 regression).
 *
 * Boundary rules (enforced by CI):
 *   - MUST NOT import `src/be/db` or `bun:sqlite` (worker/API DB boundary —
 *     `scripts/check-db-boundary.sh`). This module is HTTP-only.
 *   - MUST NOT read the API key from `process.env` directly
 *     (`scripts/check-api-key-boundary.sh`). The caller passes the key
 *     (resolved via `getApiKey()`) in `opts.apiKey`.
 *
 * Hardening vs. the original copies: every POST checks `resp.ok` and surfaces
 * a scrubbed warning on a non-2xx response or thrown error instead of
 * silently swallowing it (the swallow is exactly what hid the 2026-06-01 pi
 * drop). The sync stays NON-FATAL — a failed sync must never fail the task —
 * but it must be VISIBLE.
 */

import { scrubSecrets } from "../utils/secret-scrubber.ts";

export const SOUL_MD_PATH = "/workspace/SOUL.md";
export const IDENTITY_MD_PATH = "/workspace/IDENTITY.md";
export const TOOLS_MD_PATH = "/workspace/TOOLS.md";
export const HEARTBEAT_MD_PATH = "/workspace/HEARTBEAT.md";
export const SETUP_SCRIPT_PATH = "/workspace/start-up.sh";

// ──────────────────────────────────────────────────────────────────────────
// Identity-file baseline hashes — prevents session-end sync from clobbering
// DB-side edits made by Lead (via update-profile) during a running session.
//
// Flow:
//   1. Runner writes DB content → /workspace/*.md at session start.
//   2. Runner records SHA-256 hashes of the written content (the "baselines").
//   3. At session end, sync compares current file hash against its baseline.
//      - Hash matches → file untouched by the agent → skip sync (preserves
//        any DB-side edits Lead made during the session).
//      - Hash differs → agent modified the file → sync it back to DB.
// ──────────────────────────────────────────────────────────────────────────
export const IDENTITY_BASELINES_PATH = "/tmp/identity-baselines.json";

export type IdentityBaselines = Record<string, string>;

export function contentSha256(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

export async function writeIdentityBaselines(baselines: IdentityBaselines): Promise<void> {
  await Bun.write(IDENTITY_BASELINES_PATH, JSON.stringify(baselines));
}

export async function readIdentityBaselines(
  readFile: FileReader = readFileIfExists,
): Promise<IdentityBaselines | null> {
  try {
    const raw = await readFile(IDENTITY_BASELINES_PATH);
    if (!raw) return null;
    return JSON.parse(raw) as IdentityBaselines;
  } catch {
    return null;
  }
}
/**
 * Claude Code's personal-file CLAUDE.md path. This is what the Claude plugin
 * Stop hook reads and owns — the runner only uses it as a backstop for an
 * all-Claude batch (never overwriting it with the workspace materialization).
 */
export const CLAUDE_MD_PATH = `${process.env.HOME}/.claude/CLAUDE.md`;
/**
 * Workspace CLAUDE.md — the agent-level instructions file the runner
 * materializes from the `claudeMd` DB field at boot (`runner.ts`) and that the
 * base-prompt truncation notice tells NON-Claude harnesses (codex/pi/opencode)
 * to edit. Distinct from CLAUDE_MD_PATH; this is the FS→DB source for the
 * non-Claude providers that previously had no sync path at all.
 */
export const WORKSPACE_CLAUDE_MD_PATH = "/workspace/CLAUDE.md";

// Minimum length for SOUL.md and IDENTITY.md to prevent accidental corruption.
// Mirrors `hook.ts` (raised from 100 to 500 after profile-corruption recurrences
// where a short test sentinel synced into the real agent's DB row).
const IDENTITY_FILE_MIN_LENGTH = 500;
// Maximum file size we are willing to sync (>64KB is almost certainly not a
// hand-edited identity/config file).
const MAX_FILE_LENGTH = 65536;

const SETUP_MARKER_START = "# === Agent-managed setup (from DB) ===";
const SETUP_MARKER_END = "# === End agent-managed setup ===";

export type ProfileSyncField = "identity" | "claude" | "setup";
export type ProfileChangeSource = "self_edit" | "session_sync";

export interface ProfileSyncOptions {
  agentId: string;
  apiUrl: string;
  apiKey: string;
  /** Session-end sync uses "session_sync"; on-edit hooks use "self_edit". */
  changeSource?: ProfileChangeSource;
  /** Subset of field groups to sync. Defaults to all three. */
  fields?: ProfileSyncField[];
  /**
   * Path to read the CLAUDE.md source from. Defaults to CLAUDE_MD_PATH (Claude
   * Code's personal-file path). Non-Claude local harnesses must pass
   * WORKSPACE_CLAUDE_MD_PATH so their `/workspace/CLAUDE.md` edits sync. See
   * `resolveClaudeMdPath`.
   */
  claudeMdPath?: string;
  /** Injectable fetch for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Choose which CLAUDE.md source the runner should sync, given the harness
 * providers of the completed local sessions in a batch. Claude Code's personal
 * file lives at `~/.claude/CLAUDE.md` (CLAUDE_MD_PATH — the Stop hook's path);
 * every other local harness edits `/workspace/CLAUDE.md` (the file the runner
 * materializes and the base prompt points them to). When a batch mixes
 * providers, the presence of any non-Claude session means the workspace file is
 * the edited source of truth; an all-Claude batch uses the personal-file path,
 * where the runner only acts as a backstop for a Stop hook that didn't fire and
 * never clobbers a real personal-file edit with the stale workspace copy.
 */
export function resolveClaudeMdPath(completedProviders: readonly string[]): string {
  const anyNonClaude = completedProviders.some((p) => p !== "claude");
  return anyNonClaude ? WORKSPACE_CLAUDE_MD_PATH : CLAUDE_MD_PATH;
}

/** A single profile-update POST body, tagged with a label for logging. */
interface ProfilePayload {
  label: string;
  body: Record<string, unknown>;
}

/**
 * Pure: given the raw `start-up.sh` contents, return the agent-managed content
 * to sync, or `null` if there is nothing syncable. Extracts ONLY the content
 * between the agent-managed markers when present (so operator content isn't
 * duplicated); otherwise treats the whole file (minus a leading shebang) as
 * agent-managed.
 */
export function extractSetupScriptContent(raw: string): string | null {
  if (!raw.trim()) return null;

  const startIdx = raw.indexOf(SETUP_MARKER_START);
  const endIdx = raw.indexOf(SETUP_MARKER_END);

  let content: string;
  if (startIdx !== -1 && endIdx !== -1) {
    // Markers present — extract ONLY the content between them.
    content = raw.substring(startIdx + SETUP_MARKER_START.length, endIdx).trim();
  } else {
    // No markers — agent created/replaced the entire file. Store as-is minus shebang.
    content = raw.replace(/^#!\/bin\/bash\n/, "").trim();
  }

  if (!content || content.length > MAX_FILE_LENGTH) return null;
  return content;
}

/**
 * Pure: build the bundled identity-update body from raw file contents. Applies
 * the trim / max-length guards and the SOUL/IDENTITY min-length guard. Returns
 * an empty object when nothing is syncable (callers should skip the POST).
 * `undefined` inputs mean the file was absent.
 *
 * When `baselines` is provided, skips any field whose content hash matches the
 * baseline (i.e. the file was not modified during the session). This prevents
 * session-end sync from clobbering DB-side edits made by Lead.
 */
export function buildIdentityPayload(
  files: {
    soulMd?: string;
    identityMd?: string;
    toolsMd?: string;
    heartbeatMd?: string;
  },
  baselines?: IdentityBaselines | null,
): Record<string, string> {
  const updates: Record<string, string> = {};

  if (files.soulMd !== undefined) {
    const content = files.soulMd;
    if (baselines?.soulMd && contentSha256(content) === baselines.soulMd) {
      // File unchanged during session — skip to preserve Lead's DB edits
    } else if (content.trim() && content.length <= MAX_FILE_LENGTH) {
      if (content.length < IDENTITY_FILE_MIN_LENGTH) {
        console.error(
          `[profile-sync] Skipping SOUL.md sync: content too short (${content.length} chars, minimum ${IDENTITY_FILE_MIN_LENGTH}). This prevents accidental profile corruption.`,
        );
      } else {
        updates.soulMd = content;
      }
    }
  }

  if (files.identityMd !== undefined) {
    const content = files.identityMd;
    if (baselines?.identityMd && contentSha256(content) === baselines.identityMd) {
      // File unchanged during session — skip to preserve Lead's DB edits
    } else if (content.trim() && content.length <= MAX_FILE_LENGTH) {
      if (content.length < IDENTITY_FILE_MIN_LENGTH) {
        console.error(
          `[profile-sync] Skipping IDENTITY.md sync: content too short (${content.length} chars, minimum ${IDENTITY_FILE_MIN_LENGTH}). This prevents accidental profile corruption.`,
        );
      } else {
        updates.identityMd = content;
      }
    }
  }

  if (files.toolsMd !== undefined) {
    const content = files.toolsMd;
    if (baselines?.toolsMd && contentSha256(content) === baselines.toolsMd) {
      // File unchanged during session — skip
    } else if (content.trim() && content.length <= MAX_FILE_LENGTH) {
      updates.toolsMd = content;
    }
  }

  if (files.heartbeatMd !== undefined) {
    const content = files.heartbeatMd;
    if (baselines?.heartbeatMd && contentSha256(content) === baselines.heartbeatMd) {
      // File unchanged during session — skip
    } else if (content.length <= MAX_FILE_LENGTH) {
      updates.heartbeatMd = content;
    }
  }

  return updates;
}

/** Reads a file's text, returning `undefined` when it does not exist. */
export type FileReader = (path: string) => Promise<string | undefined>;

/** Default file reader — reads from the worker's local FS via Bun. */
async function readFileIfExists(path: string): Promise<string | undefined> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    return await file.text();
  } catch {
    return undefined;
  }
}

/**
 * Collect the profile-update POST bodies to send. Each entry is one POST.
 * `fields` selects which groups to include. The file reader is injectable so
 * the field-selection / guard logic can be unit-tested without touching the FS.
 *
 * When `changeSource` is `"session_sync"`, loads baseline hashes written at
 * session start and skips identity fields whose content hasn't changed — this
 * prevents blind-overwriting DB-side edits made by Lead during the session.
 * On-edit syncs (`"self_edit"`) bypass baselines entirely since the agent
 * explicitly changed the file and the new content should propagate.
 */
export async function collectProfilePayloads(
  fields: ProfileSyncField[],
  changeSource: ProfileChangeSource,
  readFile: FileReader = readFileIfExists,
  claudeMdPath: string = CLAUDE_MD_PATH,
): Promise<ProfilePayload[]> {
  const payloads: ProfilePayload[] = [];

  const baselines = changeSource === "session_sync" ? await readIdentityBaselines(readFile) : null;

  if (fields.includes("identity")) {
    const updates = buildIdentityPayload(
      {
        soulMd: await readFile(SOUL_MD_PATH),
        identityMd: await readFile(IDENTITY_MD_PATH),
        toolsMd: await readFile(TOOLS_MD_PATH),
        heartbeatMd: await readFile(HEARTBEAT_MD_PATH),
      },
      baselines,
    );
    if (Object.keys(updates).length > 0) {
      payloads.push({ label: "identity", body: { ...updates, changeSource } });
    }
  }

  if (fields.includes("claude")) {
    const raw = await readFile(claudeMdPath);
    if (raw?.trim() && raw.length <= MAX_FILE_LENGTH) {
      if (baselines?.claudeMd && contentSha256(raw) === baselines.claudeMd) {
        // CLAUDE.md unchanged during session — skip to preserve Lead's DB edits
      } else {
        payloads.push({ label: "claude", body: { claudeMd: raw, changeSource } });
      }
    }
  }

  if (fields.includes("setup")) {
    const raw = await readFile(SETUP_SCRIPT_PATH);
    if (raw !== undefined) {
      const content = extractSetupScriptContent(raw);
      if (content !== null) {
        payloads.push({ label: "setup", body: { setupScript: content, changeSource } });
      }
    }
  }

  return payloads;
}

/**
 * POST a single profile update. NON-FATAL but VISIBLE: a non-2xx response or a
 * thrown error is logged (scrubbed) and swallowed so it never fails the task,
 * but — unlike the original copies — it is never silently ignored.
 */
export async function postProfileUpdate(
  opts: Pick<ProfileSyncOptions, "agentId" | "apiUrl" | "apiKey" | "fetchImpl">,
  payload: ProfilePayload,
): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const resp = await doFetch(`${opts.apiUrl}/api/agents/${opts.agentId}/profile`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
        "X-Agent-ID": opts.agentId,
      },
      body: JSON.stringify(payload.body),
    });
    if (!resp.ok) {
      let detail = "";
      try {
        detail = (await resp.text()).slice(0, 500);
      } catch {
        /* ignore body read failure */
      }
      console.warn(
        scrubSecrets(
          `[profile-sync] ${payload.label} sync failed: HTTP ${resp.status}${detail ? ` — ${detail}` : ""}`,
        ),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(scrubSecrets(`[profile-sync] ${payload.label} sync errored: ${msg}`));
  }
}

/**
 * Sync the agent's local profile files back to the API. Reads SOUL/IDENTITY/
 * TOOLS/HEARTBEAT/CLAUDE.md + the agent-managed section of start-up.sh and
 * POSTs each changed group. Idempotent server-side: the profile route only
 * writes a new `context_versions` row when the content hash changes, so a
 * redundant sync (pi extension + runner, or an unchanged file) is a no-op.
 *
 * Always resolves (never throws) — failures are logged, not propagated.
 */
export async function syncProfileFilesToServer(opts: ProfileSyncOptions): Promise<void> {
  const changeSource = opts.changeSource ?? "session_sync";
  const fields = opts.fields ?? ["identity", "claude", "setup"];

  const payloads = await collectProfilePayloads(
    fields,
    changeSource,
    readFileIfExists,
    opts.claudeMdPath ?? CLAUDE_MD_PATH,
  );
  for (const payload of payloads) {
    await postProfileUpdate(opts, payload);
  }
}
