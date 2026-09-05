/**
 * Worker-side per-task identity refresh (DB → runner cache → system prompt).
 *
 * The runner reads `GET /me` exactly ONCE, at boot, into module-local
 * `agentSoulMd` / `agentIdentityMd` / `agentToolsMd` / `agentClaudeMd` / …
 * variables. `buildSystemPrompt()` is re-invoked per task, but it re-reads
 * those same boot-time values, so an identity change made after boot — Lead
 * calling `update-profile`, or the agent editing `/workspace/TOOLS.md` and the
 * PostToolUse hook syncing it — updates the DB (and the file on disk) while
 * every subsequent task keeps receiving the boot-time copy in its injected
 * system prompt. Only a container restart cleared it.
 *
 * This module is the identity counterpart of `src/utils/skills-refresh.ts`:
 * the runner calls it once per task, it re-reads the profile, and reports
 * which fields actually changed so the prompt is rebuilt with fresh content.
 *
 * Disk materialization is deliberately conservative. The runner writes the DB
 * copy to `/workspace/*.md` at boot and records baseline hashes
 * (`profile-sync.ts`) so session-end sync can tell "agent edited this file"
 * from "file is still the DB copy". A refresh reuses those baselines:
 *
 *   - file still matches its baseline → safe to rewrite from DB, re-baseline
 *   - file already equals the new DB content → nothing to write, re-baseline
 *   - file diverges from both → the agent edited it in-session; leave the file
 *     and the baseline untouched so session-end sync still pushes that edit
 *
 * The in-memory prompt fields always track the DB, which is the shared source
 * of truth and the thing this module exists to un-stale.
 *
 * Boundary rules (enforced by CI): HTTP-only, no `src/be/db` import, and the
 * API key is passed in by the caller (never read from `process.env` here).
 */

import {
  contentSha256,
  HEARTBEAT_MD_PATH,
  IDENTITY_MD_PATH,
  type IdentityBaselines,
  readIdentityBaselines,
  SOUL_MD_PATH,
  TOOLS_MD_PATH,
  WORKSPACE_CLAUDE_MD_PATH,
  writeIdentityBaselines,
} from "./profile-sync.ts";

/** The identity-derived prompt inputs the runner caches at boot. */
export interface IdentityProfileFields {
  soulMd?: string;
  identityMd?: string;
  toolsMd?: string;
  claudeMd?: string;
  heartbeatMd?: string;
  name?: string;
  description?: string;
}

/** Fields that are materialized as a file in the workspace. */
export const IDENTITY_FIELD_PATHS = {
  soulMd: SOUL_MD_PATH,
  identityMd: IDENTITY_MD_PATH,
  toolsMd: TOOLS_MD_PATH,
  heartbeatMd: HEARTBEAT_MD_PATH,
  claudeMd: WORKSPACE_CLAUDE_MD_PATH,
} as const;

export type IdentityFileField = keyof typeof IDENTITY_FIELD_PATHS;
export type IdentityField = keyof IdentityProfileFields;

const IDENTITY_FIELDS: readonly IdentityField[] = [
  "soulMd",
  "identityMd",
  "toolsMd",
  "claudeMd",
  "heartbeatMd",
  "name",
  "description",
];

function isFileField(field: IdentityField): field is IdentityFileField {
  return field in IDENTITY_FIELD_PATHS;
}

/**
 * Pure: which fields the server reports differently from the runner's cache.
 *
 * A field the server omits (`undefined`) is never a change — a slimmed or
 * partial payload must not blank a prompt section that is currently populated.
 */
export function diffIdentityFields(
  cached: IdentityProfileFields,
  fetched: IdentityProfileFields,
): IdentityField[] {
  return IDENTITY_FIELDS.filter((field) => {
    const next = fetched[field];
    if (next === undefined) return false;
    return next !== cached[field];
  });
}

/** Injectable FS access so the write policy is testable without touching disk. */
export interface IdentityFileIo {
  read: (path: string) => Promise<string | undefined>;
  write: (path: string, content: string) => Promise<void>;
}

const defaultFileIo: IdentityFileIo = {
  read: async (path) => {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) return undefined;
      return await file.text();
    } catch {
      return undefined;
    }
  },
  write: async (path, content) => {
    await Bun.write(path, content);
  },
};

export interface MaterializeResult {
  /** Paths rewritten from the refreshed DB content. */
  written: string[];
  /** Paths left alone because the agent edited them during the session. */
  skipped: string[];
  /** Baselines to persist (input baselines plus any re-baselined field). */
  baselines: IdentityBaselines;
}

/**
 * Apply refreshed identity content to the workspace files, honoring the
 * session baselines so an in-session agent edit is never clobbered.
 */
export async function materializeRefreshedIdentityFiles(
  changedFields: readonly IdentityField[],
  fetched: IdentityProfileFields,
  baselines: IdentityBaselines | null,
  io: IdentityFileIo = defaultFileIo,
): Promise<MaterializeResult> {
  const nextBaselines: IdentityBaselines = { ...(baselines ?? {}) };
  const written: string[] = [];
  const skipped: string[] = [];

  for (const field of changedFields) {
    if (!isFileField(field)) continue;
    const content = fetched[field];
    if (!content) continue;

    const path = IDENTITY_FIELD_PATHS[field];
    const onDisk = await io.read(path);

    if (onDisk === undefined) {
      // Nothing to clobber — materialize it.
      await io.write(path, content);
      nextBaselines[field] = contentSha256(content);
      written.push(path);
      continue;
    }

    if (onDisk === content) {
      // Already current (e.g. `update-profile` wrote DB and disk together).
      nextBaselines[field] = contentSha256(content);
      continue;
    }

    if (baselines?.[field] && contentSha256(onDisk) === baselines[field]) {
      // Untouched since boot — safe to replace with the newer DB copy.
      await io.write(path, content);
      nextBaselines[field] = contentSha256(content);
      written.push(path);
      continue;
    }

    // Diverges from both the baseline and the DB: an in-session agent edit.
    // Leave the file AND its baseline so session-end sync still pushes it.
    skipped.push(path);
  }

  return { written, skipped, baselines: nextBaselines };
}

export interface IdentityRefreshContext {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  role: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  io?: IdentityFileIo;
  /** Injectable for tests. */
  readBaselines?: typeof readIdentityBaselines;
  /** Injectable for tests. */
  writeBaselines?: typeof writeIdentityBaselines;
}

export interface IdentityRefreshResult {
  changed: boolean;
  /** Cached fields merged with whatever actually changed. */
  fields: IdentityProfileFields;
  changedFields: IdentityField[];
}

/**
 * Re-read the agent profile and report the fields that drifted from the
 * runner's cache. Never throws: a flaky API returns `changed: false` and the
 * caller keeps its current prompt rather than churning it.
 */
export async function refreshIdentityIfChanged(
  ctx: IdentityRefreshContext,
  cached: IdentityProfileFields,
): Promise<IdentityRefreshResult> {
  const unchanged: IdentityRefreshResult = { changed: false, fields: cached, changedFields: [] };
  const doFetch = ctx.fetchImpl ?? fetch;

  let fetched: IdentityProfileFields;
  try {
    const headers: Record<string, string> = { "X-Agent-ID": ctx.agentId };
    if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;
    const resp = await doFetch(`${ctx.apiUrl}/me`, { headers });
    if (!resp.ok) return unchanged;
    fetched = (await resp.json()) as IdentityProfileFields;
  } catch {
    return unchanged;
  }

  const changedFields = diffIdentityFields(cached, fetched);
  if (changedFields.length === 0) return unchanged;

  const fields: IdentityProfileFields = { ...cached };
  for (const field of changedFields) {
    fields[field] = fetched[field];
  }

  try {
    const baselines = (await ctx.readBaselines?.()) ?? (await readIdentityBaselines());
    const result = await materializeRefreshedIdentityFiles(
      changedFields,
      fetched,
      baselines,
      ctx.io,
    );
    if (result.written.length > 0 || result.skipped.length > 0) {
      if (result.written.length > 0) {
        console.log(`[${ctx.role}] Identity files refreshed from DB: ${result.written.join(", ")}`);
      }
      if (result.skipped.length > 0) {
        console.warn(
          `[${ctx.role}] Identity files changed in DB but edited locally — left as-is: ${result.skipped.join(", ")}`,
        );
      }
    }
    const persist = ctx.writeBaselines ?? writeIdentityBaselines;
    await persist(result.baselines);
  } catch (err) {
    // Non-fatal: the prompt still gets the fresh content even if the files or
    // the baseline file could not be updated.
    console.warn(`[${ctx.role}] Identity file refresh failed: ${(err as Error).message}`);
  }

  return { changed: true, fields, changedFields };
}
