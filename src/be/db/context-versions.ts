import type { ChangeSource, ContextVersion, VersionableField } from "../../types";
import { getDbClient } from "./runtime";

export function computeContentHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

type ContextVersionRow = {
  id: string;
  agentId: string;
  field: string;
  content: string;
  version: number;
  changeSource: string;
  changedByAgentId: string | null;
  changeReason: string | null;
  contentHash: string;
  previousVersionId: string | null;
  createdAt: string;
};

function rowToContextVersion(row: ContextVersionRow): ContextVersion {
  return {
    id: row.id,
    agentId: row.agentId,
    field: row.field as VersionableField,
    content: row.content,
    version: row.version,
    changeSource: row.changeSource as ChangeSource,
    changedByAgentId: row.changedByAgentId,
    changeReason: row.changeReason,
    contentHash: row.contentHash,
    previousVersionId: row.previousVersionId,
    createdAt: row.createdAt,
  };
}

export async function createContextVersion(params: {
  agentId: string;
  field: VersionableField;
  content: string;
  version: number;
  changeSource: ChangeSource;
  changedByAgentId?: string | null;
  changeReason?: string | null;
  contentHash: string;
  previousVersionId?: string | null;
}): Promise<ContextVersion> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const row = await getDbClient().get<ContextVersionRow>(
    `INSERT INTO context_versions (id, agentId, field, content, version, changeSource, changedByAgentId, changeReason, contentHash, previousVersionId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    [
      id,
      params.agentId,
      params.field,
      params.content,
      params.version,
      params.changeSource,
      params.changedByAgentId ?? null,
      params.changeReason ?? null,
      params.contentHash,
      params.previousVersionId ?? null,
      now,
    ],
  );

  if (!row) throw new Error("Failed to create context version");
  return rowToContextVersion(row);
}

export async function getLatestContextVersion(
  agentId: string,
  field: VersionableField,
): Promise<ContextVersion | null> {
  const row = await getDbClient().get<ContextVersionRow>(
    `SELECT * FROM context_versions WHERE agentId = ? AND field = ? ORDER BY version DESC LIMIT 1`,
    [agentId, field],
  );

  return row ? rowToContextVersion(row) : null;
}

export async function getContextVersion(id: string): Promise<ContextVersion | null> {
  const row = await getDbClient().get<ContextVersionRow>(
    `SELECT * FROM context_versions WHERE id = ?`,
    [id],
  );

  return row ? rowToContextVersion(row) : null;
}

export async function getContextVersionHistory(params: {
  agentId: string;
  field?: VersionableField;
  limit?: number;
}): Promise<ContextVersion[]> {
  const limit = params.limit ?? 10;

  if (params.field) {
    const rows = await getDbClient().query<ContextVersionRow>(
      `SELECT * FROM context_versions WHERE agentId = ? AND field = ? ORDER BY version DESC LIMIT ?`,
      [params.agentId, params.field, limit],
    );
    return rows.map(rowToContextVersion);
  }

  const rows = await getDbClient().query<ContextVersionRow>(
    `SELECT * FROM context_versions WHERE agentId = ? ORDER BY createdAt DESC LIMIT ?`,
    [params.agentId, limit],
  );
  return rows.map(rowToContextVersion);
}
