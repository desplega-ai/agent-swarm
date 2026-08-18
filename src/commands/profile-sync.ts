/**
 * Harness-agnostic FS → DB profile sync (worker-side, HTTP-only).
 *
 * Persists an agent's self-editable identity / config files back to the API:
 *   - SOUL.md / IDENTITY.md / TOOLS.md / HEARTBEAT.md  (independent POSTs)
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

import { resolveTemplateAsync } from "../prompts/resolver.ts";
import type { Agent, SwarmEvent } from "../types.ts";
import { MAX_PROFILE_FILE_LENGTH } from "../utils/constants.ts";
import {
  type BudgetedIdentityField,
  IDENTITY_FIELD_BUDGETS,
} from "../utils/identity-field-budget.ts";
import { scrubSecrets } from "../utils/secret-scrubber.ts";
import "./templates.ts";

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

export const PROFILE_MARKDOWN_FIELDS = [
  "soulMd",
  "identityMd",
  "claudeMd",
  "toolsMd",
  "heartbeatMd",
] as const;

export type ProfileMarkdownField = (typeof PROFILE_MARKDOWN_FIELDS)[number];
export type ProfileMarkdownSnapshot = Partial<
  Record<ProfileMarkdownField, string | null | undefined>
>;

export interface ProfileDivergence {
  field: ProfileMarkdownField;
  diskSize: number | null;
  dbSize: number;
  budget: number | null;
  delta: number | null;
  diskHash: string | null;
  dbHash: string;
  diskMissing: boolean;
}

/** Pure disk-vs-DB comparison used by local profile-sync audits. */
export function findProfileDivergences(
  disk: ProfileMarkdownSnapshot,
  db: ProfileMarkdownSnapshot,
): ProfileDivergence[] {
  const divergences: ProfileDivergence[] = [];

  for (const field of PROFILE_MARKDOWN_FIELDS) {
    const diskValue = disk[field];
    const dbValue = db[field] ?? "";
    const budget =
      field === "heartbeatMd" ? null : IDENTITY_FIELD_BUDGETS[field as BudgetedIdentityField];
    if (diskValue === undefined || diskValue === null) {
      if (dbValue.length === 0) continue;
      divergences.push({
        field,
        diskSize: null,
        dbSize: dbValue.length,
        budget,
        delta: null,
        diskHash: null,
        dbHash: contentSha256(dbValue),
        diskMissing: true,
      });
      continue;
    }
    if (diskValue === dbValue) continue;

    divergences.push({
      field,
      diskSize: diskValue.length,
      dbSize: dbValue.length,
      budget,
      delta: diskValue.length - dbValue.length,
      diskHash: contentSha256(diskValue),
      dbHash: contentSha256(dbValue),
      diskMissing: false,
    });
  }

  return divergences;
}

const PROFILE_FIELD_DETAILS: Record<
  BudgetedIdentityField,
  { label: string; recoveryGuidance: string }
> = {
  soulMd: {
    label: `soulMd (${SOUL_MD_PATH})`,
    recoveryGuidance: `Inspect and shrink the live ${SOUL_MD_PATH} first, moving durable tail content into memory. After a worker restart, use ${SOUL_MD_PATH}.pre-boot-<timestamp>.bak as the fallback copy of the rejected content.`,
  },
  identityMd: {
    label: `identityMd (${IDENTITY_MD_PATH})`,
    recoveryGuidance: `Inspect and shrink the live ${IDENTITY_MD_PATH} first, moving durable tail content into memory. After a worker restart, use ${IDENTITY_MD_PATH}.pre-boot-<timestamp>.bak as the fallback copy of the rejected content.`,
  },
  claudeMd: {
    label:
      "claudeMd (/workspace/CLAUDE.md for non-Claude harnesses; ~/.claude/CLAUDE.md for Claude)",
    recoveryGuidance:
      "Inspect and shrink the live CLAUDE.md source first, moving durable tail content into memory. After a worker restart, non-Claude harnesses can use /workspace/CLAUDE.md.pre-boot-<timestamp>.bak as the fallback copy; Claude's native ~/.claude/CLAUDE.md source is not archived by that boot step.",
  },
  toolsMd: {
    label: `toolsMd (${TOOLS_MD_PATH})`,
    recoveryGuidance: `Inspect and shrink the live ${TOOLS_MD_PATH} first, moving durable tail content into memory. After a worker restart, use ${TOOLS_MD_PATH}.pre-boot-<timestamp>.bak as the fallback copy of the rejected content.`,
  },
};

/** Render one persisted sync rejection through the prompt-template registry. */
export async function renderProfileSyncRejectionBanner(event: SwarmEvent): Promise<string | null> {
  const data = event.data;
  const field = data?.field;
  const diskSize = data?.diskSize;
  const dbSize = data?.dbSize;
  const budget = data?.budget;
  const delta = data?.delta;
  if (
    typeof field !== "string" ||
    !(field in PROFILE_FIELD_DETAILS) ||
    typeof diskSize !== "number" ||
    typeof dbSize !== "number" ||
    typeof budget !== "number" ||
    typeof delta !== "number"
  ) {
    return null;
  }

  const details = PROFILE_FIELD_DETAILS[field as BudgetedIdentityField];
  const result = await resolveTemplateAsync("task.profile_sync_rejection", {
    timestamp: event.createdAt,
    field_label: details.label,
    disk_size: diskSize,
    db_size: dbSize,
    budget,
    delta: delta >= 0 ? `+${delta}` : String(delta),
    event_id: event.id,
    recovery_guidance: details.recoveryGuidance,
  });
  return result.skipped ? null : result.text;
}

/** Fetch every field's latest unresolved rejection before a provider session. */
export async function fetchProfileSyncRejectionBanner(
  config: Pick<ProfileSyncOptions, "agentId" | "apiUrl" | "apiKey" | "claudeMdPath">,
  fetchImpl: typeof fetch = fetch,
  readFile: FileReader = readFileIfExists,
): Promise<string> {
  try {
    const responses = await Promise.all(
      (Object.keys(IDENTITY_FIELD_BUDGETS) as BudgetedIdentityField[]).map(async (field) => {
        const fetchLatestEvent = async (event: SwarmEvent["event"]): Promise<SwarmEvent | null> => {
          const query = new URLSearchParams({
            event,
            agentId: config.agentId,
            dataField: field,
            limit: "1",
          });
          const response = await fetchImpl(`${config.apiUrl}/api/events?${query}`, {
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "X-Agent-ID": config.agentId,
            },
          });
          if (!response.ok) return null;
          const payload = (await response.json()) as { events?: SwarmEvent[] };
          return payload.events?.[0] ?? null;
        };
        const [rejection, reconciliation] = await Promise.all([
          fetchLatestEvent("system.profile_sync_rejected"),
          fetchLatestEvent("system.profile_sync_reconciled"),
        ]);
        return { rejection, reconciliation };
      }),
    );
    const latestEvents = responses.flatMap(({ rejection, reconciliation }) =>
      rejection ? [{ rejection, reconciliation }] : [],
    );
    if (latestEvents.length === 0) return "";

    let profile: Record<string, unknown> | null = null;
    const profileResponse = await fetchImpl(`${config.apiUrl}/me`, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "X-Agent-ID": config.agentId,
      },
    });
    if (profileResponse.ok) {
      profile = (await profileResponse.json()) as Record<string, unknown>;
    }

    let disk: Partial<Record<BudgetedIdentityField, string | undefined>> | null = null;
    if (config.claudeMdPath) {
      disk = {
        soulMd: await readFile(SOUL_MD_PATH),
        identityMd: await readFile(IDENTITY_MD_PATH),
        claudeMd: await readFile(config.claudeMdPath),
        toolsMd: await readFile(TOOLS_MD_PATH),
      };
    }

    const unresolved = latestEvents.flatMap(({ rejection, reconciliation }) => {
      if (reconciliation && reconciliation.createdAt > rejection.createdAt) return [];
      const event = rejection;
      const field = event.data?.field;
      const rejectedDbHash = event.data?.dbHash;
      const currentValue = typeof field === "string" ? profile?.[field] : undefined;
      const diskValue =
        typeof field === "string" ? disk?.[field as BudgetedIdentityField] : undefined;
      if (typeof currentValue === "string" && diskValue === currentValue) return [];
      return !(
        typeof rejectedDbHash === "string" &&
        typeof currentValue === "string" &&
        contentSha256(currentValue) !== rejectedDbHash
      )
        ? [event]
        : [];
    });
    const banners = await Promise.all(unresolved.map(renderProfileSyncRejectionBanner));
    return banners.filter((banner): banner is string => banner !== null).join("");
  } catch {
    return "";
  }
}

export async function prependProfileSyncRejectionBanner(
  prompt: string,
  config: Pick<ProfileSyncOptions, "agentId" | "apiUrl" | "apiKey" | "claudeMdPath">,
  fetchImpl: typeof fetch = fetch,
  readFile: FileReader = readFileIfExists,
): Promise<{ prompt: string; injected: boolean }> {
  const banner = await fetchProfileSyncRejectionBanner(config, fetchImpl, readFile);
  return banner ? { prompt: banner + prompt, injected: true } : { prompt, injected: false };
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
const SETUP_MARKER_START = "# === Agent-managed setup (from DB) ===";
const SETUP_MARKER_END = "# === End agent-managed setup ===";

export function warnProfileFileTooLarge(
  agentId: string,
  field: string,
  actualLength: number,
  source = "profile-sync",
): void {
  console.warn(
    `[${source}] Skipping profile sync for agent ${agentId}, field ${field}: ${actualLength} characters exceeds the ${MAX_PROFILE_FILE_LENGTH}-character cap.`,
  );
}

/**
 * Preserve differing local profile content before replacing it with the DB
 * value during boot. If the archive write fails, this throws before the
 * original file is touched.
 */
export async function writeProfileFileFromDb(
  filePath: string,
  dbContent: string,
  now: () => Date = () => new Date(),
): Promise<string | null> {
  const file = Bun.file(filePath);
  let backupPath: string | null = null;

  if (await file.exists()) {
    const localContent = await file.text();
    if (localContent !== dbContent) {
      backupPath = `${filePath}.pre-boot-${now().toISOString()}.bak`;
      await Bun.write(backupPath, localContent);
    }
  }

  await Bun.write(filePath, dbContent);
  return backupPath;
}

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
export interface ProfilePayload {
  label: string;
  body: Record<string, string>;
}

/**
 * Keep identity-file sync independent: one rejected ratcheting-budget write
 * must not discard valid edits to other files from the same session.
 */
export function buildIndependentIdentityPayloads(
  updates: Record<string, string>,
  changeSource: ProfileChangeSource,
): ProfilePayload[] {
  return Object.entries(updates).map(([field, value]) => ({
    label: `identity.${field}`,
    body: { [field]: value, changeSource },
  }));
}

/**
 * Pure: given the raw `start-up.sh` contents, return the agent-managed content
 * to sync, or `null` if there is nothing syncable. Extracts ONLY the content
 * between the agent-managed markers when present (so operator content isn't
 * duplicated); otherwise treats the whole file (minus a leading shebang) as
 * agent-managed.
 */
export function extractSetupScriptContent(raw: string, agentId = "unknown"): string | null {
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

  if (!content) return null;
  if (content.length > MAX_PROFILE_FILE_LENGTH) {
    warnProfileFileTooLarge(agentId, "setupScript", content.length);
    return null;
  }
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
  agentId = "unknown",
): Record<string, string> {
  const updates: Record<string, string> = {};

  if (files.soulMd !== undefined) {
    const content = files.soulMd;
    if (baselines?.soulMd && contentSha256(content) === baselines.soulMd) {
      // File unchanged during session — skip to preserve Lead's DB edits
    } else if (content.trim()) {
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
    } else if (content.trim()) {
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
    } else if (content.trim()) {
      updates.toolsMd = content;
    }
  }

  if (files.heartbeatMd !== undefined) {
    const content = files.heartbeatMd;
    if (baselines?.heartbeatMd && contentSha256(content) === baselines.heartbeatMd) {
      // File unchanged during session — skip
    } else if (content.length > MAX_PROFILE_FILE_LENGTH) {
      warnProfileFileTooLarge(agentId, "heartbeatMd", content.length);
    } else {
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
 * Compare the five local profile markdown files with the authenticated agent's
 * stored DB values. This must run inside the agent's local environment; a
 * central script cannot read another worker container's `/workspace` files.
 */
export async function auditProfileDivergences(
  opts: Pick<ProfileSyncOptions, "agentId" | "apiUrl" | "apiKey" | "claudeMdPath" | "fetchImpl">,
  readFile: FileReader = readFileIfExists,
): Promise<ProfileDivergence[]> {
  const doFetch = opts.fetchImpl ?? fetch;
  const response = await doFetch(`${opts.apiUrl}/me`, {
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "X-Agent-ID": opts.agentId,
    },
  });
  if (!response.ok) {
    throw new Error(`Profile divergence audit failed: HTTP ${response.status}`);
  }

  const stored = (await response.json()) as Agent;
  const claudeMdPath =
    opts.claudeMdPath ??
    (stored.harnessProvider
      ? stored.harnessProvider === "claude"
        ? CLAUDE_MD_PATH
        : WORKSPACE_CLAUDE_MD_PATH
      : null);
  if (!claudeMdPath) {
    throw new Error(
      "Profile divergence audit requires a registered harness provider or an explicit claudeMdPath",
    );
  }
  const disk: ProfileMarkdownSnapshot = {
    soulMd: await readFile(SOUL_MD_PATH),
    identityMd: await readFile(IDENTITY_MD_PATH),
    claudeMd: await readFile(claudeMdPath),
    toolsMd: await readFile(TOOLS_MD_PATH),
    heartbeatMd: await readFile(HEARTBEAT_MD_PATH),
  };

  return findProfileDivergences(disk, stored);
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
  agentId = "unknown",
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
      agentId,
    );
    payloads.push(...buildIndependentIdentityPayloads(updates, changeSource));
  }

  if (fields.includes("claude")) {
    const raw = await readFile(claudeMdPath);
    if (raw?.trim()) {
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
      const content = extractSetupScriptContent(raw, agentId);
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
    opts.agentId,
  );
  for (const payload of payloads) {
    await postProfileUpdate(opts, payload);
  }
}
