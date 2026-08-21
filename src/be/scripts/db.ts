import { defaultAssetKey } from "../../assets/key";
import type {
  ScriptApiAuthMode,
  ScriptApiRecord,
  ScriptApiWithSecret,
  ScriptFsMode,
  ScriptRecord,
  ScriptScope,
  ScriptVersionRecord,
} from "../../types";
import { registerVolatileSecret } from "../../utils/secret-scrubber";
import { generateBearerToken, generateShortId } from "../../utils/short-id";
import { decryptSecret, encryptSecret, getEncryptionKey } from "../crypto";
import { computeContentHash, getDbClient } from "../db";
import { embedScript } from "./embeddings";

type ScriptRow = Omit<ScriptRecord, "isScratch" | "typeChecked"> & {
  isScratch: number;
  typeChecked: number;
};

type ScriptVersionRow = ScriptVersionRecord;

type ScriptIdentity = {
  name: string;
  scope: ScriptScope;
  scopeId?: string | null;
};

type ScriptWriteArgs = ScriptIdentity & {
  source: string;
  description: string;
  intent: string;
  signatureJson: string;
  argsJsonSchema?: string | null;
  isScratch?: boolean;
  typeChecked?: boolean;
  fsMode?: ScriptFsMode;
  agentId?: string | null;
  changeReason?: string | null;
  embeddingMode?: "sync" | "skip";
  createdBy?: string | null;
};

export type UpsertScriptResult = {
  script: ScriptRecord;
  isNew: boolean;
  contentDeduped: boolean;
};

function normalizeScopeId(scope: ScriptScope, scopeId?: string | null): string | null {
  if (scope === "global") return null;
  if (!scopeId) {
    throw new Error("scopeId is required for agent-scoped scripts");
  }
  return scopeId;
}

function rowToScript(row: ScriptRow): ScriptRecord {
  return {
    ...row,
    scopeId: row.scopeId ?? null,
    isScratch: row.isScratch === 1,
    typeChecked: row.typeChecked === 1,
    createdByAgentId: row.createdByAgentId ?? null,
  };
}

function rowToScriptVersion(row: ScriptVersionRow): ScriptVersionRecord {
  return {
    ...row,
    changedByAgentId: row.changedByAgentId ?? null,
    changeReason: row.changeReason ?? null,
  };
}

async function insertScriptVersion(args: {
  scriptId: string;
  version: number;
  source: string;
  description: string;
  intent: string;
  signatureJson: string;
  contentHash: string;
  changedByAgentId?: string | null;
  changeReason?: string | null;
}): Promise<void> {
  await getDbClient().run(
    `INSERT INTO script_versions (
        id, scriptId, version, source, description, intent, signatureJson,
        contentHash, changedByAgentId, changedAt, changeReason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomUUID(),
      args.scriptId,
      args.version,
      args.source,
      args.description,
      args.intent,
      args.signatureJson,
      args.contentHash,
      args.changedByAgentId ?? null,
      new Date().toISOString(),
      args.changeReason ?? null,
    ],
  );
}

export async function insertScript(args: ScriptWriteArgs): Promise<ScriptRecord> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const scopeId = normalizeScopeId(args.scope, args.scopeId);
  const contentHash = computeContentHash(args.source);
  const fsMode = args.fsMode ?? "none";
  const isScratch = args.isScratch ? 1 : 0;
  const typeChecked = args.typeChecked ? 1 : 0;

  return await getDbClient().transaction(async (tx) => {
    const row = await tx.get<ScriptRow>(
      `INSERT INTO scripts (
          id, "key", name, scope, scopeId, source, description, intent, signatureJson,
          argsJsonSchema, contentHash, isScratch, typeChecked, fsMode, createdByAgentId, createdAt, updatedAt,
          created_by, updated_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *`,
      [
        id,
        defaultAssetKey("script", id),
        args.name,
        args.scope,
        scopeId,
        args.source,
        args.description,
        args.intent,
        args.signatureJson,
        args.argsJsonSchema ?? null,
        contentHash,
        isScratch,
        typeChecked,
        fsMode,
        args.agentId ?? null,
        now,
        now,
        args.createdBy ?? null,
        args.createdBy ?? null,
      ],
    );

    if (!row) throw new Error("Failed to insert script");

    await insertScriptVersion({
      scriptId: row.id,
      version: row.version,
      source: row.source,
      description: row.description,
      intent: row.intent,
      signatureJson: row.signatureJson,
      contentHash: row.contentHash,
      changedByAgentId: args.agentId ?? null,
      changeReason: args.changeReason ?? "Initial creation",
    });

    return rowToScript(row);
  });
}

/**
 * Scratch saves skip embedding; they become searchable only after explicit promotion via upsert
 * OR after a `scripts reembed` pass. Explicit upserts embed synchronously so search is
 * immediately consistent for authored/promoted scripts.
 */
export async function upsertScriptByName(args: ScriptWriteArgs): Promise<UpsertScriptResult> {
  const shouldEmbed = args.embeddingMode !== "skip";
  const existing = await getScript(args);
  if (!existing) {
    const script = await insertScript(args);
    if (!script.isScratch && shouldEmbed) {
      await embedScript(script);
    }
    return {
      script,
      isNew: true,
      contentDeduped: false,
    };
  }

  const contentHash = computeContentHash(args.source);
  if (existing.contentHash === contentHash) {
    const fsMode = args.fsMode ?? existing.fsMode;
    const isScratch = args.isScratch ?? existing.isScratch;
    const typeChecked = args.typeChecked ?? existing.typeChecked;
    const argsJsonSchema =
      args.argsJsonSchema !== undefined ? args.argsJsonSchema : existing.argsJsonSchema;
    const trackedMetadataChanged =
      args.description !== existing.description ||
      args.intent !== existing.intent ||
      args.signatureJson !== existing.signatureJson ||
      argsJsonSchema !== existing.argsJsonSchema;
    const promotedFromScratch = existing.isScratch && !isScratch;
    const refreshScratchLastUsed =
      existing.scope === "agent" &&
      existing.name.startsWith("scratch-") &&
      existing.isScratch &&
      isScratch;
    if (
      fsMode !== existing.fsMode ||
      isScratch !== existing.isScratch ||
      typeChecked !== existing.typeChecked ||
      trackedMetadataChanged ||
      refreshScratchLastUsed
    ) {
      const row = await getDbClient().get<ScriptRow>(
        `UPDATE scripts
        SET description = ?, intent = ?, signatureJson = ?, argsJsonSchema = ?,
          isScratch = ?, typeChecked = ?, fsMode = ?, updatedAt = ?, updated_by = ?
        WHERE id = ?
        RETURNING *`,
        [
          args.description,
          args.intent,
          args.signatureJson,
          argsJsonSchema ?? null,
          isScratch ? 1 : 0,
          typeChecked ? 1 : 0,
          fsMode,
          new Date().toISOString(),
          args.createdBy ?? null,
          existing.id,
        ],
      );

      if (!row) throw new Error("Failed to update script metadata");
      const script = rowToScript(row);
      if (!script.isScratch && shouldEmbed && (trackedMetadataChanged || promotedFromScratch)) {
        await embedScript(script);
      }
      return {
        script,
        isNew: false,
        contentDeduped: true,
      };
    }

    return {
      script: existing,
      isNew: false,
      contentDeduped: true,
    };
  }

  const now = new Date().toISOString();
  const newVersion = existing.version + 1;
  const fsMode = args.fsMode ?? existing.fsMode;
  const isScratch = args.isScratch ?? existing.isScratch;
  const typeChecked = args.typeChecked ?? existing.typeChecked;
  const argsJsonSchema =
    args.argsJsonSchema !== undefined ? args.argsJsonSchema : existing.argsJsonSchema;

  const script = await getDbClient().transaction(async (tx) => {
    const row = await tx.get<ScriptRow>(
      `UPDATE scripts
        SET source = ?, description = ?, intent = ?, signatureJson = ?, argsJsonSchema = ?,
          contentHash = ?, version = ?, isScratch = ?, typeChecked = ?, fsMode = ?, updatedAt = ?, updated_by = ?
        WHERE id = ?
        RETURNING *`,
      [
        args.source,
        args.description,
        args.intent,
        args.signatureJson,
        argsJsonSchema ?? null,
        contentHash,
        newVersion,
        isScratch ? 1 : 0,
        typeChecked ? 1 : 0,
        fsMode,
        now,
        args.createdBy ?? null,
        existing.id,
      ],
    );

    if (!row) throw new Error("Failed to update script");

    await insertScriptVersion({
      scriptId: row.id,
      version: row.version,
      source: row.source,
      description: row.description,
      intent: row.intent,
      signatureJson: row.signatureJson,
      contentHash: row.contentHash,
      changedByAgentId: args.agentId ?? null,
      changeReason: args.changeReason ?? null,
    });

    return rowToScript(row);
  });

  if (!script.isScratch && shouldEmbed) {
    await embedScript(script);
  }

  return {
    script,
    isNew: false,
    contentDeduped: false,
  };
}

export async function getScript(args: ScriptIdentity): Promise<ScriptRecord | null> {
  const scopeId = normalizeScopeId(args.scope, args.scopeId);
  const row =
    scopeId === null
      ? await getDbClient().get<ScriptRow>(
          "SELECT * FROM scripts WHERE name = ? AND scope = ? AND scopeId IS NULL",
          [args.name, args.scope],
        )
      : await getDbClient().get<ScriptRow>(
          "SELECT * FROM scripts WHERE name = ? AND scope = ? AND scopeId = ?",
          [args.name, args.scope, scopeId],
        );

  return row ? rowToScript(row) : null;
}

export async function getScriptById(id: string): Promise<ScriptRecord | null> {
  const row = await getDbClient().get<ScriptRow>("SELECT * FROM scripts WHERE id = ?", [id]);
  return row ? rowToScript(row) : null;
}

export async function getScriptVersion(args: {
  scriptId: string;
  version?: number;
  contentHash?: string;
}): Promise<ScriptVersionRecord | null> {
  if (args.version === undefined && args.contentHash === undefined) {
    throw new Error("version or contentHash is required");
  }

  const row =
    args.version !== undefined
      ? await getDbClient().get<ScriptVersionRow>(
          "SELECT * FROM script_versions WHERE scriptId = ? AND version = ?",
          [args.scriptId, args.version],
        )
      : await getDbClient().get<ScriptVersionRow>(
          "SELECT * FROM script_versions WHERE scriptId = ? AND contentHash = ? ORDER BY version DESC LIMIT 1",
          [args.scriptId, args.contentHash as string],
        );

  return row ? rowToScriptVersion(row) : null;
}

export async function listScripts(args?: {
  scope?: ScriptScope;
  scopeId?: string | null;
  includeScratch?: boolean;
}): Promise<ScriptRecord[]> {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (args?.scope) {
    conditions.push("scope = ?");
    params.push(args.scope);

    if (args.scope === "global") {
      conditions.push("scopeId IS NULL");
    } else if (args.scopeId !== undefined) {
      conditions.push("scopeId = ?");
      params.push(normalizeScopeId(args.scope, args.scopeId));
    }
  } else if (args?.scopeId !== undefined) {
    conditions.push("scopeId = ?");
    params.push(args.scopeId ?? "");
  }

  if (!args?.includeScratch) {
    conditions.push("isScratch = 0");
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await getDbClient().query<ScriptRow>(
    `SELECT * FROM scripts ${whereClause} ORDER BY scope ASC, scopeId ASC, name ASC`,
    params,
  );
  return rows.map(rowToScript);
}

export async function listScriptVersions(scriptId: string): Promise<ScriptVersionRecord[]> {
  const rows = await getDbClient().query<ScriptVersionRow>(
    "SELECT * FROM script_versions WHERE scriptId = ? ORDER BY version DESC",
    [scriptId],
  );
  return rows.map(rowToScriptVersion);
}

export async function deleteScript(args: ScriptIdentity): Promise<boolean> {
  const existing = await getScript(args);
  if (!existing) return false;

  const result = await getDbClient().run("DELETE FROM scripts WHERE id = ?", [existing.id]);
  return result.changes > 0;
}

/** Bumps updatedAt and returns the timestamp actually written, or null if the row didn't match. */
export async function touchScratchScriptLastUsed(
  id: string,
  at: string = new Date().toISOString(),
): Promise<string | null> {
  const result = await getDbClient().run(
    `UPDATE scripts SET updatedAt = ?
     WHERE id = ? AND scope = 'agent' AND isScratch = 1 AND name GLOB 'scratch-*'`,
    [at, id],
  );
  return result.changes > 0 ? at : null;
}

/**
 * Rolls back an in-flight run-start touch after the run turns out to have
 * failed, so a failed invocation doesn't extend the retention window the way
 * a successful one does. Only applies if nothing has touched the row since
 * (CAS on updatedAt) — a concurrent run's touch, in-flight or successful,
 * always wins over this rollback.
 */
export async function restoreScratchScriptLastUsedIfUnchanged(
  id: string,
  priorUpdatedAt: string,
  expectedUpdatedAt: string,
): Promise<boolean> {
  const result = await getDbClient().run(
    `UPDATE scripts SET updatedAt = ?
     WHERE id = ? AND scope = 'agent' AND isScratch = 1 AND name GLOB 'scratch-*' AND updatedAt = ?`,
    [priorUpdatedAt, id, expectedUpdatedAt],
  );
  return result.changes > 0;
}

// ─── External script APIs (script_apis) ──────────────────────────────────────

type ScriptApiRow = {
  id: string;
  scriptId: string;
  agentId: string;
  authMode: ScriptApiAuthMode;
  bearerTokenEncrypted: string | null;
  enabled: number;
  label: string | null;
  callCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  created_by: string | null;
  updated_by: string | null;
};

/** Public-facing endpoint record incl. the encrypted token (server-side only). */
export type ScriptApiInternal = ScriptApiRecord & { bearerTokenEncrypted: string | null };

const SCRIPT_API_ID_LEN = 12;

function rowToScriptApi(row: ScriptApiRow): ScriptApiRecord {
  return {
    id: row.id,
    scriptId: row.scriptId,
    agentId: row.agentId,
    authMode: row.authMode,
    enabled: row.enabled === 1,
    label: row.label ?? null,
    callCount: row.callCount,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
  };
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/**
 * Create an external API endpoint for a script. For `authMode: 'bearer'` a
 * high-entropy token is generated and stored AES-256-GCM-encrypted; the
 * plaintext is returned ONCE (also revealable later via {@link getScriptApiSecret}).
 */
export async function createScriptApi(args: {
  scriptId: string;
  agentId: string;
  authMode: ScriptApiAuthMode;
  label?: string | null;
  createdBy?: string | null;
}): Promise<ScriptApiWithSecret> {
  const now = new Date().toISOString();
  const token = args.authMode === "bearer" ? generateBearerToken() : null;
  const encrypted = token ? encryptSecret(token, getEncryptionKey()) : null;
  const createdBy = args.createdBy ?? null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = generateShortId(SCRIPT_API_ID_LEN);
    try {
      const row = await getDbClient().get<ScriptApiRow>(
        `INSERT INTO script_apis
           (id, scriptId, agentId, authMode, bearerTokenEncrypted, enabled, label,
            callCount, lastUsedAt, createdAt, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, 1, ?, 0, NULL, ?, ?, ?)
         RETURNING *`,
        [
          id,
          args.scriptId,
          args.agentId,
          args.authMode,
          encrypted,
          args.label ?? null,
          now,
          createdBy,
          createdBy,
        ],
      );
      if (!row) throw new Error("Failed to create script API endpoint");
      if (token) registerVolatileSecret(token, `script-api:${id}`);
      return { ...rowToScriptApi(row), token };
    } catch (err) {
      if (isUniqueConstraintError(err) && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error("Failed to allocate a unique script API endpoint id");
}

export async function listScriptApisForScript(scriptId: string): Promise<ScriptApiRecord[]> {
  const rows = await getDbClient().query<ScriptApiRow>(
    "SELECT * FROM script_apis WHERE scriptId = ? ORDER BY createdAt DESC",
    [scriptId],
  );
  return rows.map(rowToScriptApi);
}

/** Look up an endpoint incl. its `enabled` flag and (encrypted) token — for the execution path. */
export async function getScriptApiById(id: string): Promise<ScriptApiInternal | null> {
  const row = await getDbClient().get<ScriptApiRow>("SELECT * FROM script_apis WHERE id = ?", [id]);
  if (!row) return null;
  return { ...rowToScriptApi(row), bearerTokenEncrypted: row.bearerTokenEncrypted ?? null };
}

/**
 * Decrypt and return the bearer token for an endpoint (or `null` if it has
 * none). Registers the plaintext with the secret scrubber so it is redacted
 * from any later log/telemetry egress — mirrors the config-reveal path.
 */
export async function getScriptApiSecret(id: string): Promise<string | null> {
  const row = await getDbClient().get<{ bearerTokenEncrypted: string | null }>(
    "SELECT bearerTokenEncrypted FROM script_apis WHERE id = ?",
    [id],
  );
  if (!row?.bearerTokenEncrypted) return null;
  const token = decryptSecret(row.bearerTokenEncrypted, getEncryptionKey());
  registerVolatileSecret(token, `script-api:${id}`);
  return token;
}

export async function updateScriptApi(
  id: string,
  args: { enabled?: boolean; label?: string | null; updatedBy?: string | null },
): Promise<ScriptApiRecord | null> {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if (args.enabled !== undefined) {
    sets.push("enabled = ?");
    vals.push(args.enabled ? 1 : 0);
  }
  if (args.label !== undefined) {
    sets.push("label = ?");
    vals.push(args.label);
  }
  if (args.updatedBy !== undefined) {
    sets.push("updated_by = ?");
    vals.push(args.updatedBy);
  }
  if (sets.length === 0) {
    const row = await getDbClient().get<ScriptApiRow>("SELECT * FROM script_apis WHERE id = ?", [
      id,
    ]);
    return row ? rowToScriptApi(row) : null;
  }
  vals.push(id);
  const row = await getDbClient().get<ScriptApiRow>(
    `UPDATE script_apis SET ${sets.join(", ")} WHERE id = ? RETURNING *`,
    vals,
  );
  return row ? rowToScriptApi(row) : null;
}

/** Rotate the bearer secret of a `bearer` endpoint. Returns `null` if the endpoint is missing or `authMode: 'none'`. */
export async function rotateScriptApiSecret(
  id: string,
  updatedBy?: string | null,
): Promise<ScriptApiWithSecret | null> {
  const existing = await getScriptApiById(id);
  if (!existing || existing.authMode !== "bearer") return null;
  const token = generateBearerToken();
  const encrypted = encryptSecret(token, getEncryptionKey());
  const row = await getDbClient().get<ScriptApiRow>(
    "UPDATE script_apis SET bearerTokenEncrypted = ?, updated_by = ? WHERE id = ? RETURNING *",
    [encrypted, updatedBy ?? null, id],
  );
  if (!row) return null;
  registerVolatileSecret(token, `script-api:${id}`);
  return { ...rowToScriptApi(row), token };
}

export async function deleteScriptApi(id: string): Promise<boolean> {
  const result = await getDbClient().run("DELETE FROM script_apis WHERE id = ?", [id]);
  return result.changes > 0;
}

/** Bump usage counters after an external invocation. Best-effort observability. */
export async function recordScriptApiUsage(id: string): Promise<void> {
  await getDbClient().run(
    "UPDATE script_apis SET callCount = callCount + 1, lastUsedAt = ? WHERE id = ?",
    [new Date().toISOString(), id],
  );
}
