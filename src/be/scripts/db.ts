import type { ScriptApiRow, ScriptRow, ScriptVersionRow } from "@desplega/storage";
import { defaultAssetKey } from "../../assets/key";
import type {
  ScriptApiAuthMode,
  ScriptApiRecord,
  ScriptApiWithSecret,
  ScriptExecutorName,
  ScriptFsMode,
  ScriptRecord,
  ScriptScope,
  ScriptVersionRecord,
} from "../../types";
import { generateBearerToken, generateShortId } from "../../utils/short-id";
import { decryptSecret, encryptSecret, getEncryptionKey } from "../crypto";
import { computeContentHash } from "../db";
import { registerStoredSecret, scriptApiSecretName } from "../secret-registry";
import { getStorage } from "../storage";
import { embedScript } from "./embeddings";

const repo = () => getStorage().repos.scripts;

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
  executor?: ScriptExecutorName | null;
  /** The writing agent: `createdByAgentId` on insert, `updatedByAgentId` on every update. */
  agentId?: string | null;
  changeReason?: string | null;
  embeddingMode?: "sync" | "skip";
  /** The person behind the write: `created_by` on insert, `updated_by` on every update. */
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
    executor: row.executor ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    createdBy: row.created_by ?? null,
    updatedBy: row.updated_by ?? null,
  } as ScriptRecord;
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
  await repo().insertScriptVersion({
    id: crypto.randomUUID(),
    scriptId: args.scriptId,
    version: args.version,
    source: args.source,
    description: args.description,
    intent: args.intent,
    signatureJson: args.signatureJson,
    contentHash: args.contentHash,
    changedByAgentId: args.changedByAgentId ?? null,
    changedAt: new Date().toISOString(),
    changeReason: args.changeReason ?? null,
  });
}

export async function insertScript(args: ScriptWriteArgs): Promise<ScriptRecord> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const scopeId = normalizeScopeId(args.scope, args.scopeId);
  const contentHash = computeContentHash(args.source);
  const fsMode = args.fsMode ?? "none";
  const executor = args.executor ?? null;
  const storage = getStorage();

  return await storage.transaction(async () => {
    const row = await storage.repos.scripts.insertScript({
      id,
      key: defaultAssetKey("script", id),
      name: args.name,
      scope: args.scope,
      scopeId,
      source: args.source,
      description: args.description,
      intent: args.intent,
      signatureJson: args.signatureJson,
      argsJsonSchema: args.argsJsonSchema ?? null,
      contentHash,
      isScratch: Boolean(args.isScratch),
      typeChecked: Boolean(args.typeChecked),
      fsMode,
      executor,
      agentId: args.agentId ?? null,
      actor: args.createdBy ?? null,
      now,
    });

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
    const executor = args.executor !== undefined ? args.executor : existing.executor;
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
      executor !== existing.executor ||
      isScratch !== existing.isScratch ||
      typeChecked !== existing.typeChecked ||
      trackedMetadataChanged ||
      refreshScratchLastUsed
    ) {
      const row = await repo().updateScriptMetadata(existing.id, {
        description: args.description,
        intent: args.intent,
        signatureJson: args.signatureJson,
        argsJsonSchema: argsJsonSchema ?? null,
        isScratch,
        typeChecked,
        fsMode,
        executor: executor ?? null,
        now: new Date().toISOString(),
        actor: args.createdBy ?? null,
        agentId: args.agentId ?? null,
      });

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
  const executor = args.executor !== undefined ? args.executor : existing.executor;
  const isScratch = args.isScratch ?? existing.isScratch;
  const typeChecked = args.typeChecked ?? existing.typeChecked;
  const argsJsonSchema =
    args.argsJsonSchema !== undefined ? args.argsJsonSchema : existing.argsJsonSchema;

  const storage = getStorage();
  const script = await storage.transaction(async () => {
    const row = await storage.repos.scripts.updateScriptContent(existing.id, {
      source: args.source,
      description: args.description,
      intent: args.intent,
      signatureJson: args.signatureJson,
      argsJsonSchema: argsJsonSchema ?? null,
      contentHash,
      version: newVersion,
      isScratch,
      typeChecked,
      fsMode,
      executor: executor ?? null,
      now,
      actor: args.createdBy ?? null,
      agentId: args.agentId ?? null,
    });

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
  const row = await repo().findScriptByName(args.name, args.scope, scopeId);

  return row ? rowToScript(row) : null;
}

/** contentHash of each named global script, in one query. Missing names are absent from the map. */
export async function getGlobalScriptContentHashes(names: string[]): Promise<Map<string, string>> {
  if (names.length === 0) return new Map();
  const rows = await repo().listGlobalScriptContentHashes(names);
  return new Map(rows.map((row) => [row.name, row.contentHash]));
}

export async function getScriptById(id: string): Promise<ScriptRecord | null> {
  const row = await repo().findScriptById(id);
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
      ? await repo().findScriptVersion(args.scriptId, args.version)
      : await repo().findLatestScriptVersionByHash(args.scriptId, args.contentHash as string);

  return row ? rowToScriptVersion(row) : null;
}

export async function listScripts(args?: {
  scope?: ScriptScope;
  scopeId?: string | null;
  includeScratch?: boolean;
}): Promise<ScriptRecord[]> {
  let scope: string | undefined;
  let scopeId: string | null | undefined;
  if (args?.scope) {
    scope = args.scope;
    if (args.scope === "global") {
      scopeId = null;
    } else if (args.scopeId !== undefined) {
      scopeId = normalizeScopeId(args.scope, args.scopeId);
    }
  } else if (args?.scopeId !== undefined) {
    scopeId = args.scopeId ?? "";
  }

  const rows = await repo().listScripts({
    scope,
    scopeId,
    includeScratch: Boolean(args?.includeScratch),
  });
  return rows.map(rowToScript);
}

export async function listScriptVersions(scriptId: string): Promise<ScriptVersionRecord[]> {
  const rows = await repo().listScriptVersions(scriptId);
  return rows.map(rowToScriptVersion);
}

export async function deleteScript(args: ScriptIdentity): Promise<boolean> {
  const existing = await getScript(args);
  if (!existing) return false;

  return (await repo().deleteScript(existing.id)) > 0;
}

/** Bumps updatedAt and returns the timestamp actually written, or null if the row didn't match. */
export async function touchScratchScriptLastUsed(
  id: string,
  at: string = new Date().toISOString(),
): Promise<string | null> {
  return (await repo().touchScratchScript(id, at)) > 0 ? at : null;
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
  return (await repo().restoreScratchScriptUpdatedAt(id, priorUpdatedAt, expectedUpdatedAt)) > 0;
}

// ─── External script APIs (script_apis) ──────────────────────────────────────

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
      const row = await repo().insertScriptApi({
        id,
        scriptId: args.scriptId,
        agentId: args.agentId,
        authMode: args.authMode,
        bearerTokenEncrypted: encrypted,
        label: args.label ?? null,
        actor: createdBy,
        now,
      });
      if (!row) throw new Error("Failed to create script API endpoint");
      registerStoredSecret(token, scriptApiSecretName(id));
      return { ...rowToScriptApi(row), token };
    } catch (err) {
      if (isUniqueConstraintError(err) && attempt < 4) continue;
      throw err;
    }
  }
  throw new Error("Failed to allocate a unique script API endpoint id");
}

/**
 * Every stored script API bearer token, decrypted, for the secret registry
 * (src/be/secret-registry.ts). A row that fails to decrypt is counted, not thrown.
 */
export async function listStoredScriptApiSecrets(): Promise<{
  secrets: { id: string; token: string }[];
  failed: number;
}> {
  const rows = await repo().listScriptApiSecrets();
  const secrets: { id: string; token: string }[] = [];
  let failed = 0;
  for (const row of rows) {
    try {
      const token = decryptSecret(row.bearerTokenEncrypted, getEncryptionKey());
      if (token) secrets.push({ id: row.id, token });
    } catch {
      failed++;
    }
  }
  return { secrets, failed };
}

export async function listScriptApisForScript(scriptId: string): Promise<ScriptApiRecord[]> {
  const rows = await repo().listScriptApisForScript(scriptId);
  return rows.map(rowToScriptApi);
}

/** Look up an endpoint incl. its `enabled` flag and (encrypted) token — for the execution path. */
export async function getScriptApiById(id: string): Promise<ScriptApiInternal | null> {
  const row = await repo().findScriptApiById(id);
  if (!row) return null;
  return { ...rowToScriptApi(row), bearerTokenEncrypted: row.bearerTokenEncrypted ?? null };
}

/**
 * Decrypt and return the bearer token for an endpoint (or `null` if it has
 * none). Registers the plaintext with the secret scrubber so it is redacted
 * from any later log/telemetry egress — mirrors the config-reveal path.
 */
export async function getScriptApiSecret(id: string): Promise<string | null> {
  const row = await repo().findScriptApiById(id);
  if (!row?.bearerTokenEncrypted) return null;
  const token = decryptSecret(row.bearerTokenEncrypted, getEncryptionKey());
  registerStoredSecret(token, scriptApiSecretName(id));
  return token;
}

export async function updateScriptApi(
  id: string,
  args: { enabled?: boolean; label?: string | null; updatedBy?: string | null },
): Promise<ScriptApiRecord | null> {
  const row = await repo().updateScriptApi(id, {
    enabled: args.enabled,
    label: args.label,
    updatedBy: args.updatedBy,
  });
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
  const row = await repo().setScriptApiToken(id, encrypted, updatedBy ?? null);
  if (!row) return null;
  registerStoredSecret(token, scriptApiSecretName(id));
  return { ...rowToScriptApi(row), token };
}

export async function deleteScriptApi(id: string): Promise<boolean> {
  return (await repo().deleteScriptApi(id)) > 0;
}

/** Bump usage counters after an external invocation. Best-effort observability. */
export async function recordScriptApiUsage(id: string): Promise<void> {
  await repo().recordScriptApiUsage(id, new Date().toISOString());
}
