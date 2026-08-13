import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  type AriaClientIntake,
  AriaClientIntakeSchema,
  type AriaEngineContract,
  type AriaEngineDraft,
  AriaEngineDraftSchema,
  type AriaEngineVersion,
  AriaEngineVersionSchema,
  type AriaKnowledgeKindSchema,
  type AriaKnowledgeRecord,
  AriaKnowledgeRecordSchema,
  type AriaKnowledgeSource,
  type AriaKnowledgeSourceKindSchema,
  AriaKnowledgeSourceSchema,
  type AriaKnowledgeSyncRun,
  AriaKnowledgeSyncRunSchema,
  type AriaSlackSurface,
  AriaSlackSurfaceSchema,
} from "./domain/types";

type KnowledgeKind = typeof AriaKnowledgeKindSchema._output;
type KnowledgeSourceKind = typeof AriaKnowledgeSourceKindSchema._output;

export interface CreateEngineDraftInput {
  id?: string;
  organizationId: string;
  name: string;
  brief: string;
  createdByUserId: string;
}

export type EngineDraftPatch = Partial<
  Pick<AriaEngineDraft, "status" | "swarmTaskId" | "proposedContract" | "errorMessage">
>;

export interface CreateEngineVersionInput {
  id?: string;
  organizationId: string;
  draftId: string;
  contract: AriaEngineContract;
  workflowId: string;
  publishedByUserId: string;
}

export interface IngestKnowledgeInput {
  id?: string;
  organizationId: string;
  kind: KnowledgeKind;
  sourceKind: KnowledgeSourceKind;
  sourceRef: string;
  sourceRevision: string;
  sourceUrl?: string;
  audience: "internal" | "client";
  clientKey?: string;
  title: string;
  content: string;
  verificationStatus: AriaKnowledgeRecord["verificationStatus"];
  effectiveAt: string;
  expiresAt?: string;
  metadata: Record<string, unknown>;
  createdByUserId?: string;
}

export interface KnowledgeSearchInput {
  organizationId: string;
  query: string;
  audience: "internal" | "client";
  clientKey?: string;
  now?: string;
  limit?: number;
}

export interface KnowledgeSearchResult {
  record: AriaKnowledgeRecord;
  score: number;
}

export interface CreateKnowledgeSourceInput {
  id?: string;
  organizationId: string;
  key: string;
  name: string;
  sourceKind: KnowledgeSourceKind;
  audience: "internal" | "client";
  clientKey?: string;
  adapter: "openapi" | "webhook";
  connectionSlug?: string;
  runAsAgentId: string;
  syncConfig: Record<string, unknown>;
  scheduleId?: string;
  webhookSecretHash?: string;
  createdByUserId: string;
}

export interface KnowledgeSyncRecordInput {
  sourceRef: string;
  sourceRevision: string;
  sourceUrl?: string;
  title: string;
  content: string;
  effectiveAt: string;
  metadata: Record<string, unknown>;
}

export interface CompleteKnowledgeSyncInput {
  sourceId: string;
  runId: string;
  agentId: string;
  nextCursor?: string;
  records: KnowledgeSyncRecordInput[];
}

export interface CreateSlackSurfaceInput {
  id?: string;
  organizationId: string;
  name: string;
  workspaceId: string;
  channelId: string;
  audience: "internal" | "client";
  clientKey?: string;
  captureMode: "mention_only" | "designated_channel";
  pmOwnerId: string;
  createdByUserId: string;
}

export interface CreateClientIntakeInput {
  id?: string;
  organizationId: string;
  slackSurfaceId: string;
  workItemId: string;
  messageTs: string;
  threadTs: string;
  externalUserId: string;
  clientStatus: AriaClientIntake["clientStatus"];
  publicSummary: string;
}

export interface AriaHqRepository {
  transaction<T>(fn: () => T): T;
  createEngineDraft(input: CreateEngineDraftInput): AriaEngineDraft;
  getEngineDraft(organizationId: string, id: string): AriaEngineDraft | null;
  listEngineDrafts(organizationId: string): AriaEngineDraft[];
  updateEngineDraft(organizationId: string, id: string, patch: EngineDraftPatch): AriaEngineDraft;
  createEngineVersion(input: CreateEngineVersionInput): AriaEngineVersion;
  getEngineVersionByDraft(organizationId: string, draftId: string): AriaEngineVersion | null;
  listEngineVersions(organizationId: string, engineKey?: string): AriaEngineVersion[];
  ingestKnowledge(input: IngestKnowledgeInput): AriaKnowledgeRecord;
  getKnowledgeRecord(organizationId: string, id: string): AriaKnowledgeRecord | null;
  searchKnowledge(input: KnowledgeSearchInput): KnowledgeSearchResult[];
  createKnowledgeSource(input: CreateKnowledgeSourceInput): AriaKnowledgeSource;
  getKnowledgeSource(organizationId: string, id: string): AriaKnowledgeSource | null;
  getKnowledgeSourceForRunner(id: string, agentId: string): AriaKnowledgeSource | null;
  getWebhookKnowledgeSource(id: string, webhookSecretHash: string): AriaKnowledgeSource | null;
  listKnowledgeSources(organizationId: string): AriaKnowledgeSource[];
  attachKnowledgeSourceSchedule(
    organizationId: string,
    sourceId: string,
    scheduleId: string,
    userId: string,
  ): AriaKnowledgeSource;
  beginKnowledgeSync(sourceId: string, agentId: string): AriaKnowledgeSyncRun;
  completeKnowledgeSync(input: CompleteKnowledgeSyncInput): AriaKnowledgeSyncRun;
  failKnowledgeSync(
    sourceId: string,
    runId: string,
    agentId: string,
    errorMessage: string,
  ): AriaKnowledgeSyncRun;
  createSlackSurface(input: CreateSlackSurfaceInput): AriaSlackSurface;
  setSlackSurfaceVerification(
    organizationId: string,
    id: string,
    result: { status: "pending" | "verified" | "failed"; errorMessage?: string },
    userId: string,
  ): AriaSlackSurface;
  findSlackSurface(workspaceId: string, channelId: string): AriaSlackSurface | null;
  listSlackSurfaces(organizationId: string): AriaSlackSurface[];
  createClientIntake(input: CreateClientIntakeInput): AriaClientIntake;
  getClientIntakeByMessage(slackSurfaceId: string, messageTs: string): AriaClientIntake | null;
  listClientIntakes(organizationId: string): AriaClientIntake[];
}

type DraftRow = {
  id: string;
  organizationId: string;
  name: string;
  brief: string;
  status: string;
  swarmTaskId: string | null;
  proposedContractJson: string | null;
  errorMessage: string | null;
  createdByUserId: string;
  createdAt: string;
  lastUpdatedAt: string;
};

type VersionRow = {
  id: string;
  organizationId: string;
  draftId: string;
  engineKey: string;
  name: string;
  version: number;
  status: string;
  contractJson: string;
  workflowId: string;
  publishedByUserId: string;
  publishedAt: string;
  createdAt: string;
  lastUpdatedAt: string;
};

type KnowledgeRow = {
  id: string;
  organizationId: string;
  kind: string;
  sourceKind: string;
  sourceRef: string;
  sourceRevision: string;
  sourceUrl: string | null;
  audience: string;
  clientKey: string | null;
  title: string;
  content: string;
  verificationStatus: string;
  effectiveAt: string;
  expiresAt: string | null;
  checksum: string;
  metadataJson: string;
  createdAt: string;
  lastUpdatedAt: string;
};

type SurfaceRow = {
  id: string;
  organizationId: string;
  name: string;
  workspaceId: string;
  channelId: string;
  audience: string;
  clientKey: string | null;
  captureMode: string;
  pmOwnerId: string;
  isActive: number;
  verificationStatus: string;
  verifiedAt: string | null;
  verificationError: string | null;
  createdByUserId: string;
  createdAt: string;
  lastUpdatedAt: string;
};

type KnowledgeSourceRow = {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  sourceKind: string;
  audience: string;
  clientKey: string | null;
  adapter: string;
  connectionSlug: string | null;
  runAsAgentId: string;
  syncConfigJson: string;
  cursor: string | null;
  scheduleId: string | null;
  enabled: number;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastErrorMessage: string | null;
  webhookSecretHash: string | null;
  createdByUserId: string;
  createdAt: string;
  lastUpdatedAt: string;
};

type KnowledgeSyncRunRow = {
  id: string;
  sourceId: string;
  agentId: string;
  status: string;
  cursorBefore: string | null;
  cursorAfter: string | null;
  recordsSeen: number;
  recordsCreated: number;
  recordsReused: number;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

type IntakeRow = {
  id: string;
  organizationId: string;
  slackSurfaceId: string;
  workItemId: string;
  messageTs: string;
  threadTs: string;
  externalUserId: string;
  clientStatus: string;
  publicSummary: string;
  createdAt: string;
  lastUpdatedAt: string;
};

function rowToDraft(row: DraftRow): AriaEngineDraft {
  return AriaEngineDraftSchema.parse({
    ...row,
    swarmTaskId: row.swarmTaskId ?? undefined,
    proposedContract: row.proposedContractJson ? JSON.parse(row.proposedContractJson) : undefined,
    errorMessage: row.errorMessage ?? undefined,
  });
}

function rowToVersion(row: VersionRow): AriaEngineVersion {
  return AriaEngineVersionSchema.parse({
    ...row,
    contract: JSON.parse(row.contractJson),
  });
}

function rowToKnowledge(row: KnowledgeRow): AriaKnowledgeRecord {
  return AriaKnowledgeRecordSchema.parse({
    ...row,
    sourceUrl: row.sourceUrl ?? undefined,
    clientKey: row.clientKey ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    metadata: JSON.parse(row.metadataJson),
  });
}

function rowToSurface(row: SurfaceRow): AriaSlackSurface {
  return AriaSlackSurfaceSchema.parse({
    ...row,
    clientKey: row.clientKey ?? undefined,
    isActive: row.isActive === 1,
    verifiedAt: row.verifiedAt ?? undefined,
    verificationError: row.verificationError ?? undefined,
  });
}

function rowToKnowledgeSource(row: KnowledgeSourceRow): AriaKnowledgeSource {
  return AriaKnowledgeSourceSchema.parse({
    ...row,
    clientKey: row.clientKey ?? undefined,
    connectionSlug: row.connectionSlug ?? undefined,
    syncConfig: JSON.parse(row.syncConfigJson),
    cursor: row.cursor ?? undefined,
    scheduleId: row.scheduleId ?? undefined,
    enabled: row.enabled === 1,
    lastSyncStatus: row.lastSyncStatus ?? undefined,
    lastSyncAt: row.lastSyncAt ?? undefined,
    lastErrorMessage: row.lastErrorMessage ?? undefined,
  });
}

function rowToKnowledgeSyncRun(row: KnowledgeSyncRunRow): AriaKnowledgeSyncRun {
  return AriaKnowledgeSyncRunSchema.parse({
    ...row,
    cursorBefore: row.cursorBefore ?? undefined,
    cursorAfter: row.cursorAfter ?? undefined,
    errorMessage: row.errorMessage ?? undefined,
    finishedAt: row.finishedAt ?? undefined,
  });
}

function rowToIntake(row: IntakeRow): AriaClientIntake {
  return AriaClientIntakeSchema.parse(row);
}

function checksumKnowledge(input: IngestKnowledgeInput): string {
  const payload = JSON.stringify({
    kind: input.kind,
    sourceKind: input.sourceKind,
    sourceRef: input.sourceRef,
    sourceRevision: input.sourceRevision,
    title: input.title,
    content: input.content,
    effectiveAt: input.effectiveAt,
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function searchTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLocaleLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 2),
    ),
  ];
}

export function createAriaHqRepository(db: Database): AriaHqRepository {
  const getKnowledgeSourceById = (id: string): AriaKnowledgeSource | null => {
    const row = db
      .prepare<KnowledgeSourceRow, [string]>("SELECT * FROM ariahq_knowledge_sources WHERE id = ?")
      .get(id);
    return row ? rowToKnowledgeSource(row) : null;
  };

  const getKnowledgeSyncRun = (id: string): AriaKnowledgeSyncRun | null => {
    const row = db
      .prepare<KnowledgeSyncRunRow, [string]>(
        "SELECT * FROM ariahq_knowledge_sync_runs WHERE id = ?",
      )
      .get(id);
    return row ? rowToKnowledgeSyncRun(row) : null;
  };

  return {
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    createEngineDraft(input) {
      const id = input.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const row = db
        .prepare<DraftRow, string[]>(
          `INSERT INTO ariahq_engine_drafts (
             id, organizationId, name, brief, status, createdByUserId,
             createdAt, lastUpdatedAt, created_by, updated_by
           ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          input.organizationId,
          input.name,
          input.brief,
          input.createdByUserId,
          now,
          now,
          input.createdByUserId,
          input.createdByUserId,
        );
      if (!row) throw new Error("Failed to create AriaHQ engine draft");
      return rowToDraft(row);
    },

    getEngineDraft(organizationId, id) {
      const row = db
        .prepare<DraftRow, [string, string]>(
          "SELECT * FROM ariahq_engine_drafts WHERE organizationId = ? AND id = ?",
        )
        .get(organizationId, id);
      return row ? rowToDraft(row) : null;
    },

    listEngineDrafts(organizationId) {
      return db
        .prepare<DraftRow, [string]>(
          "SELECT * FROM ariahq_engine_drafts WHERE organizationId = ? ORDER BY lastUpdatedAt DESC",
        )
        .all(organizationId)
        .map(rowToDraft);
    },

    updateEngineDraft(organizationId, id, patch) {
      const current = this.getEngineDraft(organizationId, id);
      if (!current) throw new Error("AriaHQ engine draft not found");
      const now = new Date().toISOString();
      const row = db
        .prepare<DraftRow, (string | null)[]>(
          `UPDATE ariahq_engine_drafts SET
             status = ?, swarmTaskId = ?, proposedContractJson = ?, errorMessage = ?,
             lastUpdatedAt = ?, updated_by = ?
           WHERE organizationId = ? AND id = ? RETURNING *`,
        )
        .get(
          patch.status ?? current.status,
          patch.swarmTaskId ?? current.swarmTaskId ?? null,
          patch.proposedContract
            ? JSON.stringify(patch.proposedContract)
            : current.proposedContract
              ? JSON.stringify(current.proposedContract)
              : null,
          patch.errorMessage ?? current.errorMessage ?? null,
          now,
          current.createdByUserId,
          organizationId,
          id,
        );
      if (!row) throw new Error("Failed to update AriaHQ engine draft");
      return rowToDraft(row);
    },

    createEngineVersion(input) {
      const id = input.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const next = db
        .prepare<{ version: number }, [string, string]>(
          `SELECT COALESCE(MAX(version), 0) + 1 AS version
           FROM ariahq_engine_versions WHERE organizationId = ? AND engineKey = ?`,
        )
        .get(input.organizationId, input.contract.engineKey)?.version;
      if (!next) throw new Error("Failed to determine AriaHQ engine version");
      const row = db
        .prepare<VersionRow, (string | number)[]>(
          `INSERT INTO ariahq_engine_versions (
             id, organizationId, draftId, engineKey, name, version, status,
             contractJson, workflowId, publishedByUserId, publishedAt,
             createdAt, lastUpdatedAt, created_by, updated_by
           ) VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          input.organizationId,
          input.draftId,
          input.contract.engineKey,
          input.contract.name,
          next,
          JSON.stringify(input.contract),
          input.workflowId,
          input.publishedByUserId,
          now,
          now,
          now,
          input.publishedByUserId,
          input.publishedByUserId,
        );
      if (!row) throw new Error("Failed to create AriaHQ engine version");
      return rowToVersion(row);
    },

    getEngineVersionByDraft(organizationId, draftId) {
      const row = db
        .prepare<VersionRow, [string, string]>(
          "SELECT * FROM ariahq_engine_versions WHERE organizationId = ? AND draftId = ?",
        )
        .get(organizationId, draftId);
      return row ? rowToVersion(row) : null;
    },

    listEngineVersions(organizationId, engineKey) {
      const rows = engineKey
        ? db
            .prepare<VersionRow, [string, string]>(
              `SELECT * FROM ariahq_engine_versions
               WHERE organizationId = ? AND engineKey = ? ORDER BY version DESC`,
            )
            .all(organizationId, engineKey)
        : db
            .prepare<VersionRow, [string]>(
              `SELECT * FROM ariahq_engine_versions
               WHERE organizationId = ? ORDER BY engineKey, version DESC`,
            )
            .all(organizationId);
      return rows.map(rowToVersion);
    },

    ingestKnowledge(input) {
      const existing = db
        .prepare<KnowledgeRow, [string, string, string, string]>(
          `SELECT * FROM ariahq_knowledge_records
           WHERE organizationId = ? AND sourceKind = ? AND sourceRef = ? AND sourceRevision = ?`,
        )
        .get(input.organizationId, input.sourceKind, input.sourceRef, input.sourceRevision);
      if (existing) return rowToKnowledge(existing);

      const id = input.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const actor = input.createdByUserId ?? null;
      const row = db
        .prepare<KnowledgeRow, (string | null)[]>(
          `INSERT INTO ariahq_knowledge_records (
             id, organizationId, kind, sourceKind, sourceRef, sourceRevision, sourceUrl,
             audience, clientKey, title, content, verificationStatus, effectiveAt,
             expiresAt, checksum, metadataJson, createdAt, lastUpdatedAt, created_by, updated_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          input.organizationId,
          input.kind,
          input.sourceKind,
          input.sourceRef,
          input.sourceRevision,
          input.sourceUrl ?? null,
          input.audience,
          input.clientKey ?? null,
          input.title,
          input.content,
          input.verificationStatus,
          input.effectiveAt,
          input.expiresAt ?? null,
          checksumKnowledge(input),
          JSON.stringify(input.metadata),
          now,
          now,
          actor,
          actor,
        );
      if (!row) throw new Error("Failed to ingest AriaHQ knowledge");
      return rowToKnowledge(row);
    },

    getKnowledgeRecord(organizationId, id) {
      const row = db
        .prepare<KnowledgeRow, [string, string]>(
          "SELECT * FROM ariahq_knowledge_records WHERE organizationId = ? AND id = ?",
        )
        .get(organizationId, id);
      return row ? rowToKnowledge(row) : null;
    },

    searchKnowledge(input) {
      if (input.audience === "client" && !input.clientKey) return [];
      const now = input.now ?? new Date().toISOString();
      const rows =
        input.audience === "client"
          ? db
              .prepare<KnowledgeRow, [string, string, string]>(
                `SELECT * FROM ariahq_knowledge_records
                 WHERE organizationId = ? AND audience = 'client' AND clientKey = ?
                   AND verificationStatus != 'superseded'
                   AND (expiresAt IS NULL OR expiresAt > ?)
                 ORDER BY effectiveAt DESC`,
              )
              .all(input.organizationId, input.clientKey!, now)
          : db
              .prepare<KnowledgeRow, [string, string]>(
                `SELECT * FROM ariahq_knowledge_records
                 WHERE organizationId = ? AND verificationStatus != 'superseded'
                   AND (expiresAt IS NULL OR expiresAt > ?)
                 ORDER BY effectiveAt DESC`,
              )
              .all(input.organizationId, now);
      const tokens = searchTokens(input.query);
      if (tokens.length === 0) return [];
      return rows
        .map(rowToKnowledge)
        .filter((record) => {
          const haystack = `${record.title} ${record.content}`.toLocaleLowerCase();
          return tokens.every((token) => haystack.includes(token));
        })
        .map((record) => {
          const title = record.title.toLocaleLowerCase();
          const content = record.content.toLocaleLowerCase();
          const lexical = tokens.reduce(
            (score, token) =>
              score + (title.includes(token) ? 2 : 0) + (content.includes(token) ? 1 : 0),
            0,
          );
          const authority =
            record.kind === "canonical_fact" && record.verificationStatus === "verified"
              ? 30
              : record.kind === "source_evidence"
                ? 20
                : 10;
          return { record, score: authority + lexical };
        })
        .sort(
          (a, b) => b.score - a.score || b.record.effectiveAt.localeCompare(a.record.effectiveAt),
        )
        .slice(0, Math.min(Math.max(input.limit ?? 12, 1), 50));
    },

    createKnowledgeSource(input) {
      if (input.audience === "client" && !input.clientKey) {
        throw new Error("Client key is required for a client knowledge source");
      }
      if (input.audience === "internal" && input.clientKey) {
        throw new Error("Internal knowledge sources cannot carry a client key");
      }
      if (input.adapter === "openapi" && !input.connectionSlug) {
        throw new Error("OpenAPI knowledge sources require a connection slug");
      }
      if (input.adapter === "webhook" && !input.webhookSecretHash) {
        throw new Error("Webhook knowledge sources require a secret hash");
      }
      const id = input.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const row = db
        .prepare<KnowledgeSourceRow, (string | number | null)[]>(
          `INSERT INTO ariahq_knowledge_sources (
             id, organizationId, "key", name, sourceKind, audience, clientKey,
             adapter, connectionSlug, runAsAgentId, syncConfigJson, scheduleId, webhookSecretHash,
             enabled, createdByUserId, createdAt, lastUpdatedAt, created_by, updated_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          input.organizationId,
          input.key,
          input.name,
          input.sourceKind,
          input.audience,
          input.clientKey ?? null,
          input.adapter,
          input.connectionSlug ?? null,
          input.runAsAgentId,
          JSON.stringify(input.syncConfig),
          input.scheduleId ?? null,
          input.webhookSecretHash ?? null,
          input.createdByUserId,
          now,
          now,
          input.createdByUserId,
          input.createdByUserId,
        );
      if (!row) throw new Error("Failed to create AriaHQ knowledge source");
      return rowToKnowledgeSource(row);
    },

    getKnowledgeSource(organizationId, id) {
      const row = db
        .prepare<KnowledgeSourceRow, [string, string]>(
          "SELECT * FROM ariahq_knowledge_sources WHERE organizationId = ? AND id = ?",
        )
        .get(organizationId, id);
      return row ? rowToKnowledgeSource(row) : null;
    },

    getKnowledgeSourceForRunner(id, agentId) {
      const row = db
        .prepare<KnowledgeSourceRow, [string, string]>(
          `SELECT * FROM ariahq_knowledge_sources
           WHERE id = ? AND runAsAgentId = ? AND enabled = 1`,
        )
        .get(id, agentId);
      return row ? rowToKnowledgeSource(row) : null;
    },

    getWebhookKnowledgeSource(id, webhookSecretHash) {
      const row = db
        .prepare<KnowledgeSourceRow, [string, string]>(
          `SELECT * FROM ariahq_knowledge_sources
           WHERE id = ? AND webhookSecretHash = ? AND adapter = 'webhook' AND enabled = 1`,
        )
        .get(id, webhookSecretHash);
      return row ? rowToKnowledgeSource(row) : null;
    },

    listKnowledgeSources(organizationId) {
      return db
        .prepare<KnowledgeSourceRow, [string]>(
          `SELECT * FROM ariahq_knowledge_sources
           WHERE organizationId = ? ORDER BY sourceKind, name`,
        )
        .all(organizationId)
        .map(rowToKnowledgeSource);
    },

    attachKnowledgeSourceSchedule(organizationId, sourceId, scheduleId, userId) {
      const row = db
        .prepare<KnowledgeSourceRow, [string, string, string, string, string]>(
          `UPDATE ariahq_knowledge_sources SET
             scheduleId = ?, lastUpdatedAt = ?, updated_by = ?
           WHERE organizationId = ? AND id = ? RETURNING *`,
        )
        .get(scheduleId, new Date().toISOString(), userId, organizationId, sourceId);
      if (!row) throw new Error("AriaHQ knowledge source not found");
      return rowToKnowledgeSource(row);
    },

    beginKnowledgeSync(sourceId, agentId) {
      const source = getKnowledgeSourceById(sourceId);
      if (!source || !source.enabled) throw new Error("AriaHQ knowledge source is unavailable");
      if (source.runAsAgentId !== agentId) {
        throw new Error("Knowledge source runner identity does not match the bound agent");
      }
      const active = db
        .prepare<KnowledgeSyncRunRow, [string]>(
          `SELECT * FROM ariahq_knowledge_sync_runs
           WHERE sourceId = ? AND status = 'running' ORDER BY startedAt DESC LIMIT 1`,
        )
        .get(sourceId);
      if (active) return rowToKnowledgeSyncRun(active);

      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      return db.transaction(() => {
        const row = db
          .prepare<KnowledgeSyncRunRow, (string | null)[]>(
            `INSERT INTO ariahq_knowledge_sync_runs (
               id, sourceId, agentId, status, cursorBefore, startedAt,
               createdAt, lastUpdatedAt, created_by, updated_by
             ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?) RETURNING *`,
          )
          .get(id, sourceId, agentId, source.cursor ?? null, now, now, now, agentId, agentId);
        db.prepare(
          `UPDATE ariahq_knowledge_sources SET
             lastSyncStatus = 'running', lastErrorMessage = NULL,
             lastUpdatedAt = ?, updated_by = ? WHERE id = ?`,
        ).run(now, agentId, sourceId);
        if (!row) throw new Error("Failed to begin AriaHQ knowledge sync");
        return rowToKnowledgeSyncRun(row);
      })();
    },

    completeKnowledgeSync(input) {
      const source = getKnowledgeSourceById(input.sourceId);
      if (!source) throw new Error("AriaHQ knowledge source not found");
      if (source.runAsAgentId !== input.agentId) {
        throw new Error("Knowledge source runner identity does not match the bound agent");
      }
      const existingRun = getKnowledgeSyncRun(input.runId);
      if (!existingRun || existingRun.sourceId !== input.sourceId) {
        throw new Error("AriaHQ knowledge sync run not found");
      }
      if (existingRun.agentId !== input.agentId) {
        throw new Error("Knowledge sync run belongs to another agent");
      }
      if (existingRun.status === "completed") return existingRun;
      if (existingRun.status !== "running") throw new Error("Knowledge sync run is not active");

      const now = new Date().toISOString();
      return db.transaction(() => {
        let created = 0;
        let reused = 0;
        for (const record of input.records) {
          const exists = db
            .prepare<{ id: string }, [string, string, string, string]>(
              `SELECT id FROM ariahq_knowledge_records
               WHERE organizationId = ? AND sourceKind = ? AND sourceRef = ? AND sourceRevision = ?`,
            )
            .get(source.organizationId, source.sourceKind, record.sourceRef, record.sourceRevision);
          this.ingestKnowledge({
            organizationId: source.organizationId,
            kind: "source_evidence",
            sourceKind: source.sourceKind,
            sourceRef: record.sourceRef,
            sourceRevision: record.sourceRevision,
            ...(record.sourceUrl ? { sourceUrl: record.sourceUrl } : {}),
            audience: source.audience,
            ...(source.clientKey ? { clientKey: source.clientKey } : {}),
            title: record.title,
            content: record.content,
            verificationStatus: "raw",
            effectiveAt: record.effectiveAt,
            metadata: { ...record.metadata, knowledgeSourceId: source.id },
            createdByUserId: source.createdByUserId,
          });
          if (exists) reused += 1;
          else created += 1;
        }

        const row = db
          .prepare<KnowledgeSyncRunRow, (string | number | null)[]>(
            `UPDATE ariahq_knowledge_sync_runs SET
               status = 'completed', cursorAfter = ?, recordsSeen = ?,
               recordsCreated = ?, recordsReused = ?, finishedAt = ?,
               lastUpdatedAt = ?, updated_by = ?
             WHERE id = ? AND sourceId = ? AND status = 'running' RETURNING *`,
          )
          .get(
            input.nextCursor ?? null,
            input.records.length,
            created,
            reused,
            now,
            now,
            input.agentId,
            input.runId,
            input.sourceId,
          );
        if (!row) throw new Error("Failed to complete AriaHQ knowledge sync");
        db.prepare(
          `UPDATE ariahq_knowledge_sources SET
             cursor = ?, lastSyncStatus = 'completed', lastSyncAt = ?,
             lastErrorMessage = NULL, lastUpdatedAt = ?, updated_by = ?
           WHERE id = ?`,
        ).run(input.nextCursor ?? source.cursor ?? null, now, now, input.agentId, input.sourceId);
        return rowToKnowledgeSyncRun(row);
      })();
    },

    failKnowledgeSync(sourceId, runId, agentId, errorMessage) {
      const source = getKnowledgeSourceById(sourceId);
      if (!source) throw new Error("AriaHQ knowledge source not found");
      if (source.runAsAgentId !== agentId) {
        throw new Error("Knowledge source runner identity does not match the bound agent");
      }
      const run = getKnowledgeSyncRun(runId);
      if (!run || run.sourceId !== sourceId || run.agentId !== agentId) {
        throw new Error("AriaHQ knowledge sync run not found");
      }
      if (run.status === "failed") return run;
      if (run.status !== "running") throw new Error("Knowledge sync run is not active");
      const now = new Date().toISOString();
      const message = errorMessage.slice(0, 2_000);
      return db.transaction(() => {
        const row = db
          .prepare<KnowledgeSyncRunRow, string[]>(
            `UPDATE ariahq_knowledge_sync_runs SET
               status = 'failed', errorMessage = ?, finishedAt = ?,
               lastUpdatedAt = ?, updated_by = ?
             WHERE id = ? AND sourceId = ? AND status = 'running' RETURNING *`,
          )
          .get(message, now, now, agentId, runId, sourceId);
        if (!row) throw new Error("Failed to record AriaHQ knowledge sync failure");
        db.prepare(
          `UPDATE ariahq_knowledge_sources SET
             lastSyncStatus = 'failed', lastSyncAt = ?, lastErrorMessage = ?,
             lastUpdatedAt = ?, updated_by = ? WHERE id = ?`,
        ).run(now, message, now, agentId, sourceId);
        return rowToKnowledgeSyncRun(row);
      })();
    },

    createSlackSurface(input) {
      const id = input.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const row = db
        .prepare<SurfaceRow, (string | null)[]>(
          `INSERT INTO ariahq_slack_surfaces (
             id, organizationId, name, workspaceId, channelId, audience, clientKey,
             captureMode, pmOwnerId, isActive, verificationStatus,
             createdByUserId, createdAt, lastUpdatedAt,
             created_by, updated_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          input.organizationId,
          input.name,
          input.workspaceId,
          input.channelId,
          input.audience,
          input.clientKey ?? null,
          input.captureMode,
          input.pmOwnerId,
          input.createdByUserId,
          now,
          now,
          input.createdByUserId,
          input.createdByUserId,
        );
      if (!row) throw new Error("Failed to create AriaHQ Slack surface");
      return rowToSurface(row);
    },

    setSlackSurfaceVerification(organizationId, id, result, userId) {
      const now = new Date().toISOString();
      const verified = result.status === "verified";
      const row = db
        .prepare<SurfaceRow, (string | number | null)[]>(
          `UPDATE ariahq_slack_surfaces SET
             verificationStatus = ?, isActive = ?, verifiedAt = ?, verificationError = ?,
             lastUpdatedAt = ?, updated_by = ?
           WHERE organizationId = ? AND id = ? RETURNING *`,
        )
        .get(
          result.status,
          verified ? 1 : 0,
          verified ? now : null,
          result.errorMessage?.slice(0, 2_000) ?? null,
          now,
          userId,
          organizationId,
          id,
        );
      if (!row) throw new Error("AriaHQ Slack surface not found");
      return rowToSurface(row);
    },

    findSlackSurface(workspaceId, channelId) {
      const row = db
        .prepare<SurfaceRow, [string, string]>(
          `SELECT * FROM ariahq_slack_surfaces
           WHERE workspaceId = ? AND channelId = ? AND isActive = 1`,
        )
        .get(workspaceId, channelId);
      return row ? rowToSurface(row) : null;
    },

    listSlackSurfaces(organizationId) {
      return db
        .prepare<SurfaceRow, [string]>(
          `SELECT * FROM ariahq_slack_surfaces
           WHERE organizationId = ? ORDER BY audience, name`,
        )
        .all(organizationId)
        .map(rowToSurface);
    },

    createClientIntake(input) {
      const id = input.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      const row = db
        .prepare<IntakeRow, string[]>(
          `INSERT INTO ariahq_client_intakes (
             id, organizationId, slackSurfaceId, workItemId, messageTs, threadTs,
             externalUserId, clientStatus, publicSummary, createdAt, lastUpdatedAt
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          input.organizationId,
          input.slackSurfaceId,
          input.workItemId,
          input.messageTs,
          input.threadTs,
          input.externalUserId,
          input.clientStatus,
          input.publicSummary,
          now,
          now,
        );
      if (!row) throw new Error("Failed to create AriaHQ client intake");
      return rowToIntake(row);
    },

    getClientIntakeByMessage(slackSurfaceId, messageTs) {
      const row = db
        .prepare<IntakeRow, [string, string]>(
          `SELECT * FROM ariahq_client_intakes
           WHERE slackSurfaceId = ? AND messageTs = ?`,
        )
        .get(slackSurfaceId, messageTs);
      return row ? rowToIntake(row) : null;
    },

    listClientIntakes(organizationId) {
      return db
        .prepare<IntakeRow, [string]>(
          `SELECT * FROM ariahq_client_intakes
           WHERE organizationId = ? ORDER BY lastUpdatedAt DESC`,
        )
        .all(organizationId)
        .map(rowToIntake);
    },
  };
}
