import type { ContextVersionRow } from "@desplega/storage";
import type { ChangeSource, ContextVersion, VersionableField } from "../../types";
import { getStorage } from "../storage";

export function computeContentHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

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

  const row = await getStorage().repos.agents.insertContextVersion({
    id,
    agentId: params.agentId,
    field: params.field,
    content: params.content,
    version: params.version,
    changeSource: params.changeSource,
    changedByAgentId: params.changedByAgentId ?? null,
    changeReason: params.changeReason ?? null,
    contentHash: params.contentHash,
    previousVersionId: params.previousVersionId ?? null,
    createdAt: now,
  });

  if (!row) throw new Error("Failed to create context version");
  return rowToContextVersion(row);
}

export async function getLatestContextVersion(
  agentId: string,
  field: VersionableField,
): Promise<ContextVersion | null> {
  const row = await getStorage().repos.agents.latestContextVersion(agentId, field);

  return row ? rowToContextVersion(row) : null;
}

export async function getContextVersion(id: string): Promise<ContextVersion | null> {
  const row = await getStorage().repos.agents.findContextVersion(id);

  return row ? rowToContextVersion(row) : null;
}

export async function getContextVersionHistory(params: {
  agentId: string;
  field?: VersionableField;
  limit?: number;
}): Promise<ContextVersion[]> {
  const limit = params.limit ?? 10;

  const rows = await getStorage().repos.agents.listContextVersions(
    params.agentId,
    params.field || undefined,
    limit,
  );
  return rows.map(rowToContextVersion);
}
