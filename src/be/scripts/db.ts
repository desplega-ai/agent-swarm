import type { ScriptFsMode, ScriptRecord, ScriptScope, ScriptVersionRecord } from "@swarm/types";
import { computeContentHash, getDb } from "../db";
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

function insertScriptVersion(args: {
  scriptId: string;
  version: number;
  source: string;
  description: string;
  intent: string;
  signatureJson: string;
  contentHash: string;
  changedByAgentId?: string | null;
  changeReason?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO script_versions (
        id, scriptId, version, source, description, intent, signatureJson,
        contentHash, changedByAgentId, changedAt, changeReason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );
}

export function insertScript(args: ScriptWriteArgs): ScriptRecord {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const scopeId = normalizeScopeId(args.scope, args.scopeId);
  const contentHash = computeContentHash(args.source);
  const fsMode = args.fsMode ?? "none";
  const isScratch = args.isScratch ? 1 : 0;
  const typeChecked = args.typeChecked ? 1 : 0;

  const txn = getDb().transaction(() => {
    const row = getDb()
      .prepare<
        ScriptRow,
        [
          string,
          string,
          ScriptScope,
          string | null,
          string,
          string,
          string,
          string,
          string | null,
          string,
          number,
          number,
          string,
          string | null,
          string,
          string,
          string | null,
          string | null,
        ]
      >(
        `INSERT INTO scripts (
          id, name, scope, scopeId, source, description, intent, signatureJson,
          argsJsonSchema, contentHash, isScratch, typeChecked, fsMode, createdByAgentId, createdAt, updatedAt,
          created_by, updated_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING *`,
      )
      .get(
        id,
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
      );

    if (!row) throw new Error("Failed to insert script");

    insertScriptVersion({
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

  return txn();
}

/**
 * Scratch saves skip embedding; they become searchable only after explicit promotion via upsert
 * OR after a `scripts reembed` pass. Explicit upserts embed synchronously so search is
 * immediately consistent for authored/promoted scripts.
 */
export async function upsertScriptByName(args: ScriptWriteArgs): Promise<UpsertScriptResult> {
  const shouldEmbed = args.embeddingMode !== "skip";
  const existing = getScript(args);
  if (!existing) {
    const script = insertScript(args);
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
    if (
      fsMode !== existing.fsMode ||
      isScratch !== existing.isScratch ||
      typeChecked !== existing.typeChecked ||
      trackedMetadataChanged
    ) {
      const row = getDb()
        .prepare<
          ScriptRow,
          [
            string,
            string,
            string,
            string | null,
            number,
            number,
            string,
            string,
            string | null,
            string,
          ]
        >(
          `UPDATE scripts
          SET description = ?, intent = ?, signatureJson = ?, argsJsonSchema = ?,
            isScratch = ?, typeChecked = ?, fsMode = ?, updatedAt = ?, updated_by = ?
          WHERE id = ?
          RETURNING *`,
        )
        .get(
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

  const txn = getDb().transaction(() => {
    const row = getDb()
      .prepare<
        ScriptRow,
        [
          string,
          string,
          string,
          string,
          string | null,
          string,
          number,
          number,
          number,
          string,
          string,
          string | null,
          string,
        ]
      >(
        `UPDATE scripts
        SET source = ?, description = ?, intent = ?, signatureJson = ?, argsJsonSchema = ?,
          contentHash = ?, version = ?, isScratch = ?, typeChecked = ?, fsMode = ?, updatedAt = ?, updated_by = ?
        WHERE id = ?
        RETURNING *`,
      )
      .get(
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
      );

    if (!row) throw new Error("Failed to update script");

    insertScriptVersion({
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

  const script = txn();
  if (!script.isScratch && shouldEmbed) {
    await embedScript(script);
  }

  return {
    script,
    isNew: false,
    contentDeduped: false,
  };
}

export function getScript(args: ScriptIdentity): ScriptRecord | null {
  const scopeId = normalizeScopeId(args.scope, args.scopeId);
  const row =
    scopeId === null
      ? getDb()
          .prepare<ScriptRow, [string, ScriptScope]>(
            "SELECT * FROM scripts WHERE name = ? AND scope = ? AND scopeId IS NULL",
          )
          .get(args.name, args.scope)
      : getDb()
          .prepare<ScriptRow, [string, ScriptScope, string]>(
            "SELECT * FROM scripts WHERE name = ? AND scope = ? AND scopeId = ?",
          )
          .get(args.name, args.scope, scopeId);

  return row ? rowToScript(row) : null;
}

export function getScriptById(id: string): ScriptRecord | null {
  const row = getDb().prepare<ScriptRow, [string]>("SELECT * FROM scripts WHERE id = ?").get(id);
  return row ? rowToScript(row) : null;
}

export function getScriptVersion(args: {
  scriptId: string;
  version?: number;
  contentHash?: string;
}): ScriptVersionRecord | null {
  if (args.version === undefined && args.contentHash === undefined) {
    throw new Error("version or contentHash is required");
  }

  const row =
    args.version !== undefined
      ? getDb()
          .prepare<ScriptVersionRow, [string, number]>(
            "SELECT * FROM script_versions WHERE scriptId = ? AND version = ?",
          )
          .get(args.scriptId, args.version)
      : getDb()
          .prepare<ScriptVersionRow, [string, string]>(
            "SELECT * FROM script_versions WHERE scriptId = ? AND contentHash = ? ORDER BY version DESC LIMIT 1",
          )
          .get(args.scriptId, args.contentHash as string);

  return row ? rowToScriptVersion(row) : null;
}

export function listScripts(args?: {
  scope?: ScriptScope;
  scopeId?: string | null;
  includeScratch?: boolean;
}): ScriptRecord[] {
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
  return getDb()
    .prepare<ScriptRow, (string | number | null)[]>(
      `SELECT * FROM scripts ${whereClause} ORDER BY scope ASC, scopeId ASC, name ASC`,
    )
    .all(...params)
    .map(rowToScript);
}

export function listScriptVersions(scriptId: string): ScriptVersionRecord[] {
  return getDb()
    .prepare<ScriptVersionRow, [string]>(
      "SELECT * FROM script_versions WHERE scriptId = ? ORDER BY version DESC",
    )
    .all(scriptId)
    .map(rowToScriptVersion);
}

export function deleteScript(args: ScriptIdentity): boolean {
  const existing = getScript(args);
  if (!existing) return false;

  const result = getDb().run("DELETE FROM scripts WHERE id = ?", [existing.id]);
  return result.changes > 0;
}
