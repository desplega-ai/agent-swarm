import type { DbParam } from "../client";
import { jsonText, likeAsciiCi, nowText } from "../dialect";
import type { SqlExecutor } from "../executor";
import { EMPTY, SqlQuery, sql, sqlJoin, sqlList, sqlWhere } from "../sql";

/**
 * Domain: memory (`agent_memory`, `agent_memory_version`, `agent_memory_edge`,
 * `memory_link`, `memory_rating`, `memory_retrieval`, and the run-time search
 * indexes `memory_fts` and `memory_vec`). Rows come back in the SQLite value
 * shape on every engine (JSON as text, timestamps as the text the column
 * stores, embeddings as raw float32 bytes).
 *
 * The full-text arm (FTS5 MATCH, bm25), the vector arm (sqlite-vec `vec0`,
 * `vec_distance_cosine`, KNN MATCH) and the run-time index tables are
 * engine-specific: they are abstract here and live in each engine's override.
 */

export type AgentMemoryRow = {
  id: string;
  agentId: string | null;
  scope: string;
  name: string;
  content: string;
  summary: string | null;
  embedding: Buffer | null;
  source: string;
  sourceTaskId: string | null;
  sourcePath: string | null;
  chunkIndex: number;
  totalChunks: number;
  tags: string;
  createdAt: string;
  accessedAt: string;
  expiresAt: string | null;
  accessCount: number;
  embeddingModel: string | null;
  alpha: number;
  beta: number;
  key: string | null;
  contentHash: string | null;
  version: number;
  updatedAt: string | null;
};

/** An agent_memory row without its embedding blob. */
export type AgentMemoryRowNoEmbedding = Omit<AgentMemoryRow, "embedding">;

export type NewMemory = {
  id: string;
  agentId: string | null;
  scope: string;
  key: string;
  name: string;
  content: string;
  summary: string | null;
  source: string;
  sourceTaskId: string | null;
  sourcePath: string | null;
  chunkIndex: number;
  totalChunks: number;
  /** JSON text. */
  tags: string;
  now: string;
  expiresAt: string | null;
  contextKey: string | null;
  contentHash: string;
  version: number;
};

export type NewMemoryVersion = {
  id: string;
  memoryId: string;
  version: number;
  content: string;
  contentHash: string;
  intent: string;
  operation: "create" | "edit" | "replace";
  changedByAgentId: string | null;
  now: string;
};

/** One chunk rewrite of a memory edit or move. */
export type MemoryChunkUpdate = {
  id: string;
  content: string;
  contentHash: string;
  version: number;
  updatedAt: string;
  key: string | null;
  /** When true `expiresAt` is written; otherwise the stored expiry is kept. */
  resetExpiry: boolean;
  expiresAt: string | null;
};

export type MemoryScrubColumns = { name: string; content: string; summary: string | null };

/** Owner of a document: the rows sharing (key, scope, agentId). A NULL agentId matches NULL. */
export type MemoryDocumentOwner = { key: string; scope: string; agentId: string | null };

/** Visibility and filter of a memory search or list. */
export type MemoryFilter = {
  agentId: string;
  scope: string;
  isLead: boolean;
  keyPrefix?: string;
  source?: string;
};

/** What makes a task a review task: its taskType, or any of these tags. */
export type ReviewTaskRule = { taskType: string; tags: readonly string[] };

export type MemorySearchFilter = MemoryFilter & {
  includeExpired: boolean;
  /** Set when the recaller is a review task: drop review-sourced task_completion rows. */
  excludeReviewTaskCompletions?: ReviewTaskRule;
};

export type MemoryListFilter = MemoryFilter & {
  ownerAgentId?: string;
  /** Lowercased, trimmed needle; matched as a substring of the lowercased sourcePath. */
  sourcePathNeedle?: string;
};

export type MemoryStatsRows = {
  total: number;
  bySource: { source: string; count: number }[];
  byScope: { scope: string; count: number }[];
  withEmbeddings: number;
  expired: number;
};

export type MemoryHealthCountsRow = {
  total: number;
  withEmbedding: number;
  validEmbedding: number;
  invalidEmbedding: number;
  searchable: number;
  memoryVec: number;
  missingFromVec: number;
  extraInVec: number;
};

export type MemoryEdgeDbRow = { to_id: string; alpha: number; beta: number; createdAt: string };

export type MemoryRetrievalListRow = {
  id: string;
  name: string;
  content: string;
  scope: string;
  source: string;
  scheduleId: string | null;
  similarity: number | null;
  retrievalSource: string | null;
  retrievedAt: string;
};

export type NewMemoryRetrieval = {
  id: string;
  taskId: string;
  agentId: string;
  sessionId: string | null;
  memoryId: string;
  similarity: number;
  retrievedAt: string;
  contextKey: string | null;
  intent: string | null;
  eventType: string;
  retrievalId: string;
  rank: number;
  retrievalSource: string | null;
  relevance: number | null;
};

export type NewMemoryRating = {
  id: string;
  memoryId: string;
  taskId: string | null;
  source: string;
  signal: number;
  weight: number;
  reasoning: string | null;
  createdAt: string;
  contextKey: string | null;
  model: string | null;
};

export type MemoryDemotionEvidenceRow = {
  memoryId: string;
  selfAlpha: number;
  selfBeta: number;
  llmAlpha: number;
  llmBeta: number;
  llmCount: number;
};

export type NewMemoryLink = {
  id: string;
  fromMemoryId: string;
  linkType: string;
  targetKind: string;
  targetId: string;
  strength: number;
  resolver: string;
  sourceText: string | null;
  metadata: string | null;
  now: string;
};

export type MemoryLinkIdentityRow = {
  id: string;
  linkType: string;
  targetKind: string;
  targetId: string;
  sourceText: string | null;
};

export type MemoryOutgoingLinkRow = {
  id: string;
  linkType: string;
  targetKind: string;
  targetId: string;
  strength: number;
  resolver: string;
  sourceText: string | null;
  createdAt: string;
  targetMemoryId: string | null;
  targetName: string | null;
  targetScope: string | null;
  targetAgentId: string | null;
};

export type MemoryBacklinkRow = {
  id: string;
  linkType: string;
  strength: number;
  sourceText: string | null;
  createdAt: string;
  fromId: string;
  fromName: string;
  fromScope: string;
};

export type MemoryGraphNeighborRow = AgentMemoryRow & {
  fromMemoryId: string;
  linkStrength: number | null;
};

export type MemoryKeySummaryRow = {
  key: string;
  scope: string;
  agentId: string | null;
  memoryId: string;
  name: string;
  source: string;
  chunkRows: number;
  totalChunks: number;
  minTotalChunks: number;
  distinctIndexes: number;
  maxIndex: number;
  chars: number;
  accessCount: number;
  lastAccessedAt: string | null;
  alpha: number;
  beta: number;
  usefulRatings: number;
  notUsefulRatings: number;
  createdAt: string;
  updatedAt: string;
};

export type MemoryUsefulnessRows = {
  volume: {
    retrievals: number;
    distinctMemories: number;
    retrievalGroups: number;
    searchEvents: number | null;
    getEvents: number | null;
  };
  arms: {
    retrievalSource: string | null;
    retrievals: number;
    distinctMemories: number;
    citedRetrievals: number | null;
  }[];
  sources: { source: string; ratings: number; positive: number | null; avgSignal: number | null }[];
  posterior: {
    totalMemories: number;
    movedFromPrior: number | null;
    avgPosteriorMean: number | null;
    avgPosteriorMeanMoved: number | null;
    aboveThreshold: number | null;
  };
  totalRetrievalRows: number;
  ratingsBySource: { source: string; count: number }[];
};

/**
 * A read-only statement runner other than the repository's own executor: the
 * memory search reads run on worker threads with their own connection. It
 * receives the SQL rendered for this engine.
 */
export type MemoryReadExecutor = {
  query<T>(text: string, params: DbParam[]): Promise<T[]>;
  get<T>(text: string, params: DbParam[]): Promise<T | null>;
};

type Reader = {
  query<T>(query: SqlQuery): Promise<T[]>;
  get<T>(query: SqlQuery): Promise<T | null>;
};

export interface MemoryRepository {
  // ---- agent_memory: rows ----
  insertMemory(row: NewMemory): Promise<AgentMemoryRow | null>;
  insertMemoryVersion(row: NewMemoryVersion): Promise<void>;
  findMemoryById(id: string): Promise<AgentMemoryRow | null>;
  /** Bump accessedAt and accessCount of one row. */
  touchMemory(id: string, now: string): Promise<void>;
  /** Ids of the document's rows of one source. Order unspecified (callers use the set). */
  listDocumentIdsOfSource(owner: MemoryDocumentOwner, source: string): Promise<string[]>;
  /** Ids of the document's rows. Order unspecified (callers use the set). */
  listDocumentIds(owner: MemoryDocumentOwner): Promise<string[]>;
  deleteMemoriesByIds(ids: string[]): Promise<number>;
  /** The lowest-chunkIndex row of the document. */
  findFirstChunk(owner: MemoryDocumentOwner): Promise<AgentMemoryRow | null>;
  /** Every row of the document, chunkIndex ascending (ties in engine order). */
  listChunks(owner: MemoryDocumentOwner): Promise<AgentMemoryRow[]>;
  /** Any one row id of the document, or null. */
  findAnyIdOfDocument(owner: MemoryDocumentOwner): Promise<string | null>;
  updateChunk(update: MemoryChunkUpdate): Promise<void>;
  /**
   * Rows automated curation may touch: source not in `protectedSources` and key
   * not `longtermRoot` nor under it. Order unspecified (engine scan order).
   */
  listForCuration(
    agentId: string | undefined,
    protectedSources: readonly string[],
    longtermRoot: string,
  ): Promise<{ id: string; source: string; name: string; createdAt: string }[]>;
  /** Order unspecified (engine scan order). */
  listForReembedding(agentId?: string): Promise<{ id: string; content: string }[]>;
  /** Order unspecified (callers use the set). */
  listIdsBySourcePath(sourcePath: string, agentId: string): Promise<string[]>;
  deleteBySourcePath(sourcePath: string, agentId: string): Promise<number>;
  /** Ids whose expiresAt is at or before now, id ascending. */
  listExpiredIds(): Promise<string[]>;
  /** The ids among `ids` that are still expired. Order unspecified (callers use the set). */
  filterStillExpired(ids: string[]): Promise<string[]>;
  setEmbedding(id: string, embedding: Uint8Array, model: string): Promise<number>;
  clearEmbedding(id: string): Promise<void>;
  /** Compare-and-set rewrite of the scrubbed columns. Returns the changed row count. */
  rewriteForScrub(
    id: string,
    before: MemoryScrubColumns,
    after: MemoryScrubColumns & { contentHash: string; dropEmbedding: boolean },
  ): Promise<number>;
  getStatsRows(agentId: string): Promise<MemoryStatsRows>;
  /** createdAt descending (ties in engine order), then the page. */
  list(filter: MemoryListFilter, limit: number, offset: number): Promise<AgentMemoryRow[]>;
  count(filter: MemoryListFilter): Promise<number>;
  /** Rows with no embedding or one that is not `vectorBytes` long. */
  countInvalidEmbeddings(vectorBytes: number): Promise<number>;
  /** Same rows as countInvalidEmbeddings. Order unspecified (engine scan order). */
  listInvalidEmbeddings(vectorBytes: number): Promise<{ id: string; content: string }[]>;
  /** Up to `limit` rows with id > `afterId`, id ascending. */
  listContentAfter(afterId: string, limit: number): Promise<{ id: string; content: string }[]>;
  /** Learning replay: a row of the task with this hash under `learningsRoot/`. */
  findLearningReplay(
    taskId: string,
    contentHash: string,
    learningsRoot: string,
  ): Promise<{ id: string; key: string } | null>;
  findSwarmIdByKey(key: string): Promise<string | null>;
  /** One id whose name matches, own or swarm scope (engine order picks). */
  findIdByNameVisible(name: string, agentId: string): Promise<string | null>;
  getScopeOwner(id: string): Promise<{ scope: string; agentId: string | null } | null>;
  getPosteriorsByIds(ids: string[]): Promise<{ id: string; alpha: number; beta: number }[]>;
  /** Bump accessedAt/accessCount on each id. */
  recordAccesses(ids: string[], now: string): Promise<void>;

  // ---- search arms (read through `reader` when given) ----
  /**
   * FTS arm: rows that match any of `terms` (each term a phrase), best first
   * (`rank` ascending: bm25 on SQLite, minus the same bm25 score on Postgres).
   * Each engine builds its own query from the terms; no terms match nothing.
   */
  searchFtsRows(
    terms: string[],
    filter: MemorySearchFilter,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<(AgentMemoryRow & { rank: number })[]>;
  /** Vector arm: KNN distance ascending, at most `limit`, KNN width `knn`. */
  searchVecRows(
    embedding: Uint8Array,
    filter: MemorySearchFilter,
    knn: number,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<(AgentMemoryRow & { distance: number })[]>;
  /** Exhaustive arm, scored by the engine: rows in the capped set (updatedAt DESC, id). */
  countCappedRows(
    filter: MemorySearchFilter,
    cap: number,
    reader?: MemoryReadExecutor,
  ): Promise<number>;
  /** Exhaustive arm, scored by the engine: similarity DESC, id ascending. */
  scoreCappedRows(
    embedding: Uint8Array,
    filter: MemorySearchFilter,
    cap: number,
    floor: number,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<{ id: string; similarity: number }[]>;
  /** Exhaustive arm, scored by the caller: id + embedding, updatedAt DESC then id. */
  listCappedEmbeddings(
    filter: MemorySearchFilter,
    cap: number,
    reader?: MemoryReadExecutor,
  ): Promise<{ id: string; embedding: Buffer }[]>;
  /** Brute-force arm: every eligible row with an embedding. Order unspecified (engine scan order). */
  listEmbeddedRows(
    filter: MemorySearchFilter,
    reader?: MemoryReadExecutor,
  ): Promise<AgentMemoryRow[]>;
  /** Full rows of `ids`. Order unspecified (callers key by id). */
  listRowsByIds(ids: string[], reader?: MemoryReadExecutor): Promise<AgentMemoryRow[]>;
  /** id + embedding of `ids`. Order unspecified (callers key by id). */
  listEmbeddingsByIds(
    ids: string[],
    reader?: MemoryReadExecutor,
  ): Promise<{ id: string; embedding: Buffer | null }[]>;
  /** The eight health counts in one statement; vec counts are 0 unless `vecUsable`. */
  healthCounts(
    vectorBytes: number,
    vecUsable: boolean,
    reader?: MemoryReadExecutor,
  ): Promise<MemoryHealthCountsRow | null>;
  /** Per-rater rating mass of each id. Order unspecified (callers key by memoryId). */
  listDemotionEvidence(
    ids: string[],
    reader?: MemoryReadExecutor,
  ): Promise<MemoryDemotionEvidenceRow[]>;
  /** Task type and raw JSON tags of each id. Order unspecified (callers use the set). */
  listTaskKinds(
    ids: string[],
  ): Promise<{ id: string; taskType: string | null; tags: string | null }[]>;

  // ---- run-time search indexes ----
  /**
   * The definition of the full-text index (the FTS5 CREATE text on SQLite, the
   * GIN index definition of `memory_fts` on Postgres), or null when it does not
   * exist.
   */
  ftsTableSchema(): Promise<string | null>;
  /**
   * The definition of the vector table `memory_vec` (the vec0 CREATE text on
   * SQLite, its columns on Postgres), or null when it does not exist.
   */
  vecTableSchema(reader?: MemoryReadExecutor): Promise<string | null>;
  /**
   * One batch of index rows after `afterRowid`, index order. Orphan: its memory
   * is gone (Postgres has none: a foreign key deletes the row with its memory,
   * and its rows come in the order of their memory's rowid).
   */
  scanFtsBatch(
    afterRowid: number,
    limit: number,
  ): Promise<{ rowid: number; memoryId: string | null; orphan: number }[]>;
  deleteFtsRowsByRowid(rowids: number[]): Promise<void>;
  /** One batch of memory ids after `afterRowid`, insertion order. */
  scanMemoryIdBatch(afterRowid: number, limit: number): Promise<{ rowid: number; id: string }[]>;
  /** Index the rows of `ids` the index does not hold yet. */
  insertMissingFtsRows(ids: string[]): Promise<void>;
  deleteFtsRow(memoryId: string): Promise<void>;
  insertFtsRow(memoryId: string, name: string, content: string): Promise<void>;
  deleteFtsRows(memoryIds: string[]): Promise<void>;
  deleteVecRows(memoryIds: string[]): Promise<void>;
  deleteVecRow(memoryId: string): Promise<void>;
  insertVecRow(memoryId: string, embedding: Uint8Array): Promise<void>;

  // ---- agent_memory_edge ----
  /** references-source edges from the memory, createdAt descending (ties in engine order). */
  listReferenceEdges(memoryId: string): Promise<MemoryEdgeDbRow[]>;
  /** Insert with prior 1 + delta, or add the deltas to the stored posterior. */
  upsertReferenceEdge(
    fromId: string,
    toId: string,
    alphaDelta: number,
    betaDelta: number,
    now: string,
  ): Promise<void>;

  // ---- memory_rating ----
  memoryExists(id: string): Promise<boolean>;
  addPosterior(id: string, alphaDelta: number, betaDelta: number): Promise<void>;
  insertRating(row: NewMemoryRating): Promise<void>;

  // ---- memory_retrieval ----
  insertRetrieval(row: NewMemoryRetrieval): Promise<void>;
  /** Newest first by retrievedAt (ties in engine order), at most `limit`. */
  listRetrievalsForAgent(
    agentId: string,
    filter: { taskId?: string; sessionId?: string },
    snippetChars: number,
    limit: number,
  ): Promise<MemoryRetrievalListRow[]>;
  hasRetrievalForTask(taskId: string, memoryId: string): Promise<boolean>;
  /** Order unspecified (engine scan order). */
  listRetrievalsForTask(taskId: string): Promise<{ memoryId: string; similarity: number | null }[]>;
  /** Delete up to `limit` search rows retrieved before `cutoff`. */
  purgeSearchRetrievalsBefore(cutoff: string, limit: number): Promise<number>;
  getUsefulnessRows(cutoff: string, threshold: number): Promise<MemoryUsefulnessRows>;

  // ---- memory_link ----
  /** Insert unless the link identity exists (or the row is otherwise refused). */
  insertLinkIfAbsent(link: NewMemoryLink): Promise<void>;
  /** Content-derived links (linkType != 'sequel') from the memory. Order unspecified. */
  listContentLinks(memoryId: string): Promise<MemoryLinkIdentityRow[]>;
  deleteLink(id: string): Promise<void>;
  /** createdAt, then id. */
  listOutgoingLinks(memoryId: string): Promise<MemoryOutgoingLinkRow[]>;
  /** createdAt, then id. `viewerAgentId` undefined means a lead (no visibility filter). */
  listBacklinks(
    memoryId: string,
    visibility: { isLead: boolean; viewerAgentId: string | null },
  ): Promise<MemoryBacklinkRow[]>;
  /** One-hop memory neighbours. Order unspecified (callers reduce per neighbour). */
  listGraphNeighbors(parentIds: string[], filter: MemoryFilter): Promise<MemoryGraphNeighborRow[]>;

  // ---- key browser ----
  /** One row per keyed document under the literal `prefix`: key, scope, owner order. */
  listKeySummaries(
    prefix: string,
    visibleToAgentId: string | undefined,
    limit: number,
  ): Promise<MemoryKeySummaryRow[]>;
  findChunkRowById(id: string): Promise<AgentMemoryRowNoEmbedding | null>;
  /** chunkIndex, createdAt, id. */
  listChunkRowsOfDocument(owner: MemoryDocumentOwner): Promise<AgentMemoryRowNoEmbedding[]>;
  /** scope, owner, chunkIndex, createdAt, id. */
  listChunkRowsByKey(filter: {
    key: string;
    scope?: string;
    agentId?: string | null;
    visibleToAgentId?: string;
  }): Promise<AgentMemoryRowNoEmbedding[]>;
}

const CHUNK_COLUMNS = sql`id, "agentId", scope, key, name, content, summary, source, "sourceTaskId",
    "sourcePath", "chunkIndex", "totalChunks", tags, "createdAt", "updatedAt", "accessedAt", "expiresAt",
    "accessCount", "embeddingModel", alpha, beta, "contentHash", version`;

/** `m.` (or nothing) before a column. The alias is chosen by code, never by input. */
function prefixOf(alias: string): SqlQuery {
  if (alias !== "" && !/^[a-z]+$/.test(alias)) throw new Error(`Not a table alias: ${alias}`);
  return new SqlQuery([alias ? `${alias}.` : ""], []);
}

/** `COALESCE("agentId", '') = COALESCE(?, '')`, the NULL-matching owner check. */
function sameOwner(agentId: string | null): SqlQuery {
  return sql`COALESCE("agentId", '') = COALESCE(${agentId}, '')`;
}

export abstract class BaseMemoryRepository implements MemoryRepository {
  constructor(protected readonly db: SqlExecutor) {}

  /** Run reads through `reader` (rendered for this engine), or the executor. */
  protected via(reader: MemoryReadExecutor | undefined): Reader {
    if (!reader) return this.db;
    const dialect = this.db.dialect;
    return {
      query: <T>(query: SqlQuery) => {
        const { text, params } = query.render(dialect);
        return reader.query<T>(text, params);
      },
      get: <T>(query: SqlQuery) => {
        const { text, params } = query.render(dialect);
        return reader.get<T>(text, params);
      },
    };
  }

  // ---- filters ----

  /** `m.` (or nothing) before a column of the aliased table. */
  protected prefix(alias: string): SqlQuery {
    return prefixOf(alias);
  }

  /** Search visibility, in the order the conditions are written. */
  protected scopeConditions(
    conditions: SqlQuery[],
    agentId: string,
    scope: string,
    isLead: boolean,
    alias = "",
  ): void {
    const p = prefixOf(alias);
    if (!isLead) {
      if (scope === "agent") {
        conditions.push(sql`${p}"agentId" = ${agentId} AND ${p}scope = 'agent'`);
      } else if (scope === "swarm") {
        conditions.push(sql`${p}scope = 'swarm'`);
      } else {
        conditions.push(sql`(${p}"agentId" = ${agentId} OR ${p}scope = 'swarm')`);
      }
    } else if (scope === "agent") {
      conditions.push(sql`${p}scope = 'agent'`);
    } else if (scope === "swarm") {
      conditions.push(sql`${p}scope = 'swarm'`);
    }
  }

  /**
   * Literal prefix match on `key`. substr/length instead of GLOB or LIKE so a
   * prefix holding `*`, `?`, `[` or `%` is matched as text, not as a pattern.
   */
  protected keyPrefixCondition(
    conditions: SqlQuery[],
    keyPrefix: string | undefined,
    alias = "",
  ): void {
    if (!keyPrefix) return;
    conditions.push(sql`substr(${prefixOf(alias)}key, 1, length(${keyPrefix})) = ${keyPrefix}`);
  }

  /**
   * A review recaller's filter: drop `task_completion` rows whose source task
   * is a review task. Reads the task's JSON tags, so each engine writes it.
   */
  protected abstract notReviewTaskCompletion(alias: string, rule: ReviewTaskRule): SqlQuery;

  /** The shared search WHERE conditions after the arm's own leading ones. */
  protected searchConditions(
    leading: SqlQuery[],
    filter: MemorySearchFilter,
    alias = "",
  ): SqlQuery[] {
    const p = prefixOf(alias);
    const conditions = [...leading];
    this.scopeConditions(conditions, filter.agentId, filter.scope, filter.isLead, alias);
    this.keyPrefixCondition(conditions, filter.keyPrefix, alias);
    if (filter.excludeReviewTaskCompletions) {
      conditions.push(this.notReviewTaskCompletion(alias, filter.excludeReviewTaskCompletions));
    }
    if (filter.source) conditions.push(sql`${p}source = ${filter.source}`);
    if (!filter.includeExpired) {
      conditions.push(sql`(${p}"expiresAt" IS NULL OR ${p}"expiresAt" > ${nowText})`);
    }
    return conditions;
  }

  /** FROM..LIMIT of the exhaustive arm's capped eligible set, newest first. */
  protected cappedSet(
    filter: MemorySearchFilter,
    cap: number,
    orderBy: SqlQuery = sql`ORDER BY "updatedAt" DESC, id`,
  ): SqlQuery {
    const conditions = this.searchConditions([sql`embedding IS NOT NULL`], filter);
    return sql`FROM agent_memory
       WHERE ${sqlJoin(conditions, sql` AND `)}
       ${orderBy}
       LIMIT ${cap}`;
  }

  // ---- agent_memory: rows ----

  insertMemory(r: NewMemory): Promise<AgentMemoryRow | null> {
    return this.db.get<AgentMemoryRow>(sql`
      INSERT INTO agent_memory (id, "agentId", scope, key, name, content, summary, source, "sourceTaskId", "sourcePath", "chunkIndex", "totalChunks", tags, "createdAt", "updatedAt", "accessedAt", "expiresAt", "accessCount", "embeddingModel", "contextKey", "contentHash", version)
      VALUES (${r.id}, ${r.agentId}, ${r.scope}, ${r.key}, ${r.name}, ${r.content}, ${r.summary}, ${r.source}, ${r.sourceTaskId}, ${r.sourcePath}, ${r.chunkIndex}, ${r.totalChunks}, ${jsonText(r.tags)}, ${r.now}, ${r.now}, ${r.now}, ${r.expiresAt}, ${0}, ${null}, ${r.contextKey}, ${r.contentHash}, ${r.version}) RETURNING *`);
  }

  async insertMemoryVersion(v: NewMemoryVersion): Promise<void> {
    await this.db.run(sql`
      INSERT INTO agent_memory_version (id, memory_id, version, content, "contentHash", intent, operation, "changedByAgentId", "createdAt", "updatedAt", created_by, updated_by)
      VALUES (${v.id}, ${v.memoryId}, ${v.version}, ${v.content}, ${v.contentHash}, ${v.intent}, ${v.operation}, ${v.changedByAgentId}, ${v.now}, ${v.now}, ${v.changedByAgentId}, ${v.changedByAgentId})`);
  }

  findMemoryById(id: string): Promise<AgentMemoryRow | null> {
    return this.db.get<AgentMemoryRow>(sql`SELECT * FROM agent_memory WHERE id = ${id}`);
  }

  async touchMemory(id: string, now: string): Promise<void> {
    await this.db.run(
      sql`UPDATE agent_memory SET "accessedAt" = ${now}, "accessCount" = "accessCount" + 1 WHERE id = ${id}`,
    );
  }

  async listDocumentIdsOfSource(owner: MemoryDocumentOwner, source: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM agent_memory
       WHERE key = ${owner.key} AND scope = ${owner.scope} AND ${sameOwner(owner.agentId)} AND source = ${source}`);
    return rows.map((row) => row.id);
  }

  async listDocumentIds(owner: MemoryDocumentOwner): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      sql`SELECT id FROM agent_memory WHERE key = ${owner.key} AND scope = ${owner.scope} AND ${sameOwner(owner.agentId)}`,
    );
    return rows.map((row) => row.id);
  }

  async deleteMemoriesByIds(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.db.run(sql`DELETE FROM agent_memory WHERE id IN (${sqlList(ids)})`);
    return result.changes;
  }

  findFirstChunk(owner: MemoryDocumentOwner): Promise<AgentMemoryRow | null> {
    return this.db.get<AgentMemoryRow>(sql`
      SELECT * FROM agent_memory
       WHERE key = ${owner.key} AND scope = ${owner.scope} AND ${sameOwner(owner.agentId)}
       ORDER BY "chunkIndex" ASC
       LIMIT 1`);
  }

  listChunks(owner: MemoryDocumentOwner): Promise<AgentMemoryRow[]> {
    return this.db.query<AgentMemoryRow>(sql`
      SELECT * FROM agent_memory
       WHERE key = ${owner.key} AND scope = ${owner.scope} AND ${sameOwner(owner.agentId)}
       ORDER BY "chunkIndex" ASC`);
  }

  async findAnyIdOfDocument(owner: MemoryDocumentOwner): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(sql`
      SELECT id FROM agent_memory
       WHERE key = ${owner.key} AND scope = ${owner.scope} AND ${sameOwner(owner.agentId)}
       LIMIT 1`);
    return row?.id ?? null;
  }

  async updateChunk(u: MemoryChunkUpdate): Promise<void> {
    await this.db.run(sql`
      UPDATE agent_memory
         SET content = ${u.content}, "contentHash" = ${u.contentHash}, version = ${u.version}, "updatedAt" = ${u.updatedAt}, key = ${u.key},
             "expiresAt" = CASE WHEN ${u.resetExpiry ? 1 : 0} = 1 THEN ${u.expiresAt} ELSE "expiresAt" END
       WHERE id = ${u.id}`);
  }

  listForCuration(
    agentId: string | undefined,
    protectedSources: readonly string[],
    longtermRoot: string,
  ): Promise<{ id: string; source: string; name: string; createdAt: string }[]> {
    // A /longterm key is protected whatever its source.
    const notLongterm = sql`COALESCE(key, '') != ${longtermRoot} AND substr(COALESCE(key, ''), 1, ${longtermRoot.length + 1}) != ${`${longtermRoot}/`}`;
    const notProtected =
      protectedSources.length > 0 ? sql`source NOT IN (${sqlList(protectedSources)}) AND ` : EMPTY;
    const owner = agentId !== undefined ? sql`"agentId" = ${agentId} AND ` : EMPTY;
    return this.db.query(sql`
      SELECT id, source, name, "createdAt" FROM agent_memory
       WHERE ${owner}${notProtected}${notLongterm}`);
  }

  listForReembedding(agentId?: string): Promise<{ id: string; content: string }[]> {
    if (agentId) {
      return this.db.query(sql`SELECT id, content FROM agent_memory WHERE "agentId" = ${agentId}`);
    }
    return this.db.query(sql`SELECT id, content FROM agent_memory`);
  }

  async listIdsBySourcePath(sourcePath: string, agentId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      sql`SELECT id FROM agent_memory WHERE "sourcePath" = ${sourcePath} AND "agentId" = ${agentId}`,
    );
    return rows.map((row) => row.id);
  }

  async deleteBySourcePath(sourcePath: string, agentId: string): Promise<number> {
    const result = await this.db.run(
      sql`DELETE FROM agent_memory WHERE "sourcePath" = ${sourcePath} AND "agentId" = ${agentId}`,
    );
    return result.changes;
  }

  async listExpiredIds(): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      sql`SELECT id FROM agent_memory WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= ${nowText} ORDER BY id`,
    );
    return rows.map((row) => row.id);
  }

  async filterStillExpired(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.query<{ id: string }>(sql`
      SELECT id FROM agent_memory WHERE id IN (${sqlList(ids)})
       AND "expiresAt" IS NOT NULL AND "expiresAt" <= ${nowText}`);
    return rows.map((row) => row.id);
  }

  async setEmbedding(id: string, embedding: Uint8Array, model: string): Promise<number> {
    const result = await this.db.run(
      sql`UPDATE agent_memory SET embedding = ${embedding}, "embeddingModel" = ${model} WHERE id = ${id}`,
    );
    return result.changes;
  }

  async clearEmbedding(id: string): Promise<void> {
    await this.db.run(
      sql`UPDATE agent_memory SET embedding = NULL, "embeddingModel" = NULL WHERE id = ${id}`,
    );
  }

  async rewriteForScrub(
    id: string,
    before: MemoryScrubColumns,
    after: MemoryScrubColumns & { contentHash: string; dropEmbedding: boolean },
  ): Promise<number> {
    const drop = after.dropEmbedding ? 1 : 0;
    const result = await this.db.run(sql`
      UPDATE agent_memory
         SET name = ${after.name}, content = ${after.content}, summary = ${after.summary}, "contentHash" = ${after.contentHash},
             embedding = CASE WHEN ${drop} = 1 THEN NULL ELSE embedding END,
             "embeddingModel" = CASE WHEN ${drop} = 1 THEN NULL ELSE "embeddingModel" END
       WHERE id = ${id} AND name IS NOT DISTINCT FROM ${before.name}
         AND content IS NOT DISTINCT FROM ${before.content}
         AND summary IS NOT DISTINCT FROM ${before.summary}`);
    return result.changes;
  }

  async getStatsRows(agentId: string): Promise<MemoryStatsRows> {
    const total = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) as count FROM agent_memory WHERE "agentId" = ${agentId}`,
    );
    const bySource = await this.db.query<{ source: string; count: number }>(
      sql`SELECT source, COUNT(*) as count FROM agent_memory WHERE "agentId" = ${agentId} GROUP BY source`,
    );
    const byScope = await this.db.query<{ scope: string; count: number }>(
      sql`SELECT scope, COUNT(*) as count FROM agent_memory WHERE "agentId" = ${agentId} GROUP BY scope`,
    );
    const withEmbeddings = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) as count FROM agent_memory WHERE "agentId" = ${agentId} AND embedding IS NOT NULL`,
    );
    const expired = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) as count FROM agent_memory WHERE "agentId" = ${agentId} AND "expiresAt" IS NOT NULL AND "expiresAt" <= ${nowText}`,
    );
    return {
      total: total?.count ?? 0,
      bySource,
      byScope,
      withEmbeddings: withEmbeddings?.count ?? 0,
      expired: expired?.count ?? 0,
    };
  }

  protected listWhere(filter: MemoryListFilter): SqlQuery {
    const conditions: SqlQuery[] = [];
    this.scopeConditions(conditions, filter.agentId, filter.scope, filter.isLead);
    this.keyPrefixCondition(conditions, filter.keyPrefix);
    if (filter.ownerAgentId) conditions.push(sql`"agentId" = ${filter.ownerAgentId}`);
    if (filter.source) conditions.push(sql`source = ${filter.source}`);
    if (filter.sourcePathNeedle) {
      // A substring test: the needle's LIKE wildcards are escaped. Both engines
      // fold ASCII case only, as SQLite's lower() does.
      const pattern = `%${filter.sourcePathNeedle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(sql`${likeAsciiCi(sql`coalesce("sourcePath", '')`, sql`${pattern}`, "\\")}`);
    }
    return sqlWhere(conditions);
  }

  list(filter: MemoryListFilter, limit: number, offset: number): Promise<AgentMemoryRow[]> {
    return this.db.query<AgentMemoryRow>(
      // Insertion order breaks createdAt ties, so LIMIT/OFFSET pages neither skip nor repeat rows.
      sql`SELECT * FROM agent_memory${this.listWhere(filter)} ORDER BY "createdAt" DESC, ${this.insertionOrder()} ASC LIMIT ${limit} OFFSET ${offset}`,
    );
  }

  /** The insertion key: `rowid` on SQLite, `"_rowid"` on Postgres. */
  protected abstract insertionOrder(): SqlQuery;

  async count(filter: MemoryListFilter): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM agent_memory${this.listWhere(filter)}`,
    );
    return row?.count ?? 0;
  }

  async countInvalidEmbeddings(vectorBytes: number): Promise<number> {
    const row = await this.db.get<{ count: number }>(
      sql`SELECT COUNT(*) as count FROM agent_memory WHERE embedding IS NULL OR length(embedding) != ${vectorBytes}`,
    );
    return row?.count ?? 0;
  }

  listInvalidEmbeddings(vectorBytes: number): Promise<{ id: string; content: string }[]> {
    return this.db.query(
      sql`SELECT id, content FROM agent_memory WHERE embedding IS NULL OR length(embedding) != ${vectorBytes}`,
    );
  }

  listContentAfter(afterId: string, limit: number): Promise<{ id: string; content: string }[]> {
    return this.db.query(
      sql`SELECT id, content FROM agent_memory WHERE id > ${afterId} ORDER BY id ASC LIMIT ${limit}`,
    );
  }

  findLearningReplay(
    taskId: string,
    contentHash: string,
    learningsRoot: string,
  ): Promise<{ id: string; key: string } | null> {
    return this.db.get<{ id: string; key: string }>(sql`
      SELECT id, key FROM agent_memory
       WHERE "sourceTaskId" = ${taskId} AND "contentHash" = ${contentHash} AND ${likeAsciiCi(sql`key`, sql`${`${learningsRoot}/%`}`)}
       LIMIT 1`);
  }

  async findSwarmIdByKey(key: string): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM agent_memory WHERE scope = 'swarm' AND key = ${key} LIMIT 1`,
    );
    return row?.id ?? null;
  }

  async findIdByNameVisible(name: string, agentId: string): Promise<string | null> {
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM agent_memory WHERE name = ${name} AND ("agentId" = ${agentId} OR scope = 'swarm') LIMIT 1`,
    );
    return row?.id ?? null;
  }

  getScopeOwner(id: string): Promise<{ scope: string; agentId: string | null } | null> {
    return this.db.get(sql`SELECT scope, "agentId" FROM agent_memory WHERE id = ${id}`);
  }

  async getPosteriorsByIds(ids: string[]): Promise<{ id: string; alpha: number; beta: number }[]> {
    if (ids.length === 0) return [];
    return this.db.query(
      sql`SELECT id, alpha, beta FROM agent_memory WHERE id IN (${sqlList(ids)})`,
    );
  }

  async recordAccesses(ids: string[], now: string): Promise<void> {
    for (const id of ids) await this.touchMemory(id, now);
  }

  // ---- search arms ----

  abstract searchFtsRows(
    terms: string[],
    filter: MemorySearchFilter,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<(AgentMemoryRow & { rank: number })[]>;

  abstract searchVecRows(
    embedding: Uint8Array,
    filter: MemorySearchFilter,
    knn: number,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<(AgentMemoryRow & { distance: number })[]>;

  async countCappedRows(
    filter: MemorySearchFilter,
    cap: number,
    reader?: MemoryReadExecutor,
  ): Promise<number> {
    const row = await this.via(reader).get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM (SELECT 1 ${this.cappedSet(filter, cap)})`,
    );
    return row?.n ?? 0;
  }

  abstract scoreCappedRows(
    embedding: Uint8Array,
    filter: MemorySearchFilter,
    cap: number,
    floor: number,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<{ id: string; similarity: number }[]>;

  listCappedEmbeddings(
    filter: MemorySearchFilter,
    cap: number,
    reader?: MemoryReadExecutor,
  ): Promise<{ id: string; embedding: Buffer }[]> {
    return this.via(reader).query(sql`SELECT id, embedding ${this.cappedSet(filter, cap)}`);
  }

  listEmbeddedRows(
    filter: MemorySearchFilter,
    reader?: MemoryReadExecutor,
  ): Promise<AgentMemoryRow[]> {
    const conditions = this.searchConditions([sql`embedding IS NOT NULL`], filter);
    return this.via(reader).query<AgentMemoryRow>(
      sql`SELECT * FROM agent_memory${sqlWhere(conditions)}`,
    );
  }

  async listRowsByIds(ids: string[], reader?: MemoryReadExecutor): Promise<AgentMemoryRow[]> {
    if (ids.length === 0) return [];
    return this.via(reader).query<AgentMemoryRow>(
      sql`SELECT * FROM agent_memory WHERE id IN (${sqlList(ids)})`,
    );
  }

  async listEmbeddingsByIds(
    ids: string[],
    reader?: MemoryReadExecutor,
  ): Promise<{ id: string; embedding: Buffer | null }[]> {
    if (ids.length === 0) return [];
    return this.via(reader).query(
      sql`SELECT id, embedding FROM agent_memory WHERE id IN (${sqlList(ids)})`,
    );
  }

  abstract healthCounts(
    vectorBytes: number,
    vecUsable: boolean,
    reader?: MemoryReadExecutor,
  ): Promise<MemoryHealthCountsRow | null>;

  async listDemotionEvidence(
    ids: string[],
    reader?: MemoryReadExecutor,
  ): Promise<MemoryDemotionEvidenceRow[]> {
    if (ids.length === 0) return [];
    return this.via(reader).query<MemoryDemotionEvidenceRow>(sql`
      SELECT "memoryId",
             SUM(CASE WHEN source = 'explicit-self' AND signal > 0 THEN signal * weight ELSE 0 END) AS "selfAlpha",
             SUM(CASE WHEN source = 'explicit-self' AND signal < 0 THEN -signal * weight ELSE 0 END) AS "selfBeta",
             SUM(CASE WHEN source = 'llm' AND signal > 0 THEN signal * weight ELSE 0 END) AS "llmAlpha",
             SUM(CASE WHEN source = 'llm' AND signal < 0 THEN -signal * weight ELSE 0 END) AS "llmBeta",
             SUM(CASE WHEN source = 'llm' THEN 1 ELSE 0 END) AS "llmCount"
        FROM memory_rating
       WHERE source IN ('explicit-self', 'llm') AND "memoryId" IN (${sqlList(ids)})
       GROUP BY "memoryId"`);
  }

  async listTaskKinds(
    ids: string[],
  ): Promise<{ id: string; taskType: string | null; tags: string | null }[]> {
    if (ids.length === 0) return [];
    return this.db.query(
      sql`SELECT id, "taskType", tags FROM agent_tasks WHERE id IN (${sqlList(ids)})`,
    );
  }

  // ---- run-time search indexes ----

  abstract ftsTableSchema(): Promise<string | null>;
  abstract vecTableSchema(reader?: MemoryReadExecutor): Promise<string | null>;
  abstract scanFtsBatch(
    afterRowid: number,
    limit: number,
  ): Promise<{ rowid: number; memoryId: string | null; orphan: number }[]>;
  abstract deleteFtsRowsByRowid(rowids: number[]): Promise<void>;
  abstract scanMemoryIdBatch(
    afterRowid: number,
    limit: number,
  ): Promise<{ rowid: number; id: string }[]>;
  abstract insertMissingFtsRows(ids: string[]): Promise<void>;
  abstract deleteFtsRow(memoryId: string): Promise<void>;
  abstract insertFtsRow(memoryId: string, name: string, content: string): Promise<void>;
  abstract deleteFtsRows(memoryIds: string[]): Promise<void>;
  abstract deleteVecRows(memoryIds: string[]): Promise<void>;
  abstract deleteVecRow(memoryId: string): Promise<void>;
  abstract insertVecRow(memoryId: string, embedding: Uint8Array): Promise<void>;

  // ---- agent_memory_edge ----

  listReferenceEdges(memoryId: string): Promise<MemoryEdgeDbRow[]> {
    return this.db.query<MemoryEdgeDbRow>(sql`
      SELECT to_id, alpha, beta, "createdAt"
        FROM agent_memory_edge
       WHERE from_id = ${memoryId} AND type = 'references-source'
       ORDER BY "createdAt" DESC`);
  }

  async upsertReferenceEdge(
    fromId: string,
    toId: string,
    alphaDelta: number,
    betaDelta: number,
    now: string,
  ): Promise<void> {
    // The `- 1.0` corrections undo the prior the insert arm baked into
    // excluded.alpha/excluded.beta: on update the stored posterior gains the deltas.
    await this.db.run(sql`
      INSERT INTO agent_memory_edge (from_id, to_id, type, alpha, beta, "createdAt")
      VALUES (${fromId}, ${toId}, 'references-source', ${1.0 + alphaDelta}, ${1.0 + betaDelta}, ${now})
      ON CONFLICT(from_id, to_id, type) DO UPDATE SET
        alpha = agent_memory_edge.alpha + excluded.alpha - 1.0,
        beta  = agent_memory_edge.beta  + excluded.beta  - 1.0`);
  }

  // ---- memory_rating ----

  async memoryExists(id: string): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM agent_memory WHERE id = ${id}`,
    );
    return row !== null && row !== undefined;
  }

  async addPosterior(id: string, alphaDelta: number, betaDelta: number): Promise<void> {
    await this.db.run(
      sql`UPDATE agent_memory SET alpha = alpha + ${alphaDelta}, beta = beta + ${betaDelta} WHERE id = ${id}`,
    );
  }

  async insertRating(r: NewMemoryRating): Promise<void> {
    await this.db.run(sql`
      INSERT INTO memory_rating
        (id, "memoryId", "taskId", source, signal, weight, reasoning, "createdAt", "contextKey", model)
      VALUES (${r.id}, ${r.memoryId}, ${r.taskId}, ${r.source}, ${r.signal}, ${r.weight}, ${r.reasoning}, ${r.createdAt}, ${r.contextKey}, ${r.model})`);
  }

  // ---- memory_retrieval ----

  async insertRetrieval(r: NewMemoryRetrieval): Promise<void> {
    await this.db.run(sql`
      INSERT INTO memory_retrieval
        (id, "taskId", "agentId", "sessionId", "memoryId", similarity, "retrievedAt", "contextKey", intent, "eventType", "retrievalId", rank, "retrievalSource", relevance)
      VALUES (${r.id}, ${r.taskId}, ${r.agentId}, ${r.sessionId}, ${r.memoryId}, ${r.similarity}, ${r.retrievedAt}, ${r.contextKey}, ${r.intent}, ${r.eventType}, ${r.retrievalId}, ${r.rank}, ${r.retrievalSource}, ${r.relevance})`);
  }

  listRetrievalsForAgent(
    agentId: string,
    filter: { taskId?: string; sessionId?: string },
    snippetChars: number,
    limit: number,
  ): Promise<MemoryRetrievalListRow[]> {
    const conditions = [sql`mr."agentId" = ${agentId}`];
    if (filter.taskId) conditions.push(sql`mr."taskId" = ${filter.taskId}`);
    if (filter.sessionId) conditions.push(sql`mr."sessionId" = ${filter.sessionId}`);
    return this.db.query<MemoryRetrievalListRow>(sql`
      SELECT am.id        AS id,
             am.name      AS name,
             substr(am.content, 1, ${snippetChars}) AS content,
             am.scope     AS scope,
             am.source    AS source,
             t."scheduleId" AS "scheduleId",
             mr.similarity AS similarity,
             mr."retrievalSource" AS "retrievalSource",
             mr."retrievedAt" AS "retrievedAt"
        FROM memory_retrieval mr
        INNER JOIN agent_memory am ON am.id = mr."memoryId"
        LEFT JOIN  agent_tasks t   ON t.id = am."sourceTaskId"
       WHERE ${sqlJoin(conditions, sql` AND `)}
       ORDER BY mr."retrievedAt" DESC
       LIMIT ${limit}`);
  }

  async hasRetrievalForTask(taskId: string, memoryId: string): Promise<boolean> {
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM memory_retrieval WHERE "taskId" = ${taskId} AND "memoryId" = ${memoryId} LIMIT 1`,
    );
    return row != null;
  }

  listRetrievalsForTask(
    taskId: string,
  ): Promise<{ memoryId: string; similarity: number | null }[]> {
    return this.db.query(
      sql`SELECT "memoryId", similarity FROM memory_retrieval WHERE "taskId" = ${taskId}`,
    );
  }

  abstract purgeSearchRetrievalsBefore(cutoff: string, limit: number): Promise<number>;

  async getUsefulnessRows(cutoff: string, threshold: number): Promise<MemoryUsefulnessRows> {
    // SUM(CASE …) instead of COUNT(*) FILTER for maximum SQLite compatibility.
    const volume = (await this.db.get<MemoryUsefulnessRows["volume"]>(sql`
      SELECT COUNT(*)                                                AS retrievals,
             COUNT(DISTINCT "memoryId")                              AS "distinctMemories",
             COUNT(DISTINCT "retrievalId")                           AS "retrievalGroups",
             SUM(CASE WHEN "eventType" = 'search' THEN 1 ELSE 0 END) AS "searchEvents",
             SUM(CASE WHEN "eventType" = 'get' THEN 1 ELSE 0 END)    AS "getEvents"
        FROM memory_retrieval
       WHERE "retrievedAt" > ${cutoff}`))!;
    const arms = await this.db.query<MemoryUsefulnessRows["arms"][number]>(sql`
      SELECT mr."retrievalSource"          AS "retrievalSource",
             COUNT(*)                      AS retrievals,
             COUNT(DISTINCT mr."memoryId") AS "distinctMemories",
             SUM(CASE WHEN EXISTS (
                   SELECT 1
                     FROM memory_rating rt
                    WHERE rt."taskId" = mr."taskId"
                      AND rt."memoryId" = mr."memoryId"
                      AND rt.source = 'implicit-citation'
                      AND rt.signal > 0
                 ) THEN 1 ELSE 0 END)      AS "citedRetrievals"
        FROM memory_retrieval mr
       WHERE mr."retrievedAt" > ${cutoff}
         AND (mr."eventType" IS NULL OR mr."eventType" = 'search')
       GROUP BY mr."retrievalSource"
       ORDER BY retrievals DESC`);
    const sources = await this.db.query<MemoryUsefulnessRows["sources"][number]>(sql`
      SELECT am.source                                       AS source,
             COUNT(*)                                        AS ratings,
             SUM(CASE WHEN mr.signal > 0 THEN 1 ELSE 0 END)  AS positive,
             AVG(mr.signal)                                  AS "avgSignal"
        FROM memory_rating mr
        JOIN agent_memory am ON am.id = mr."memoryId"
       WHERE mr.source = 'implicit-citation'
         AND mr."createdAt" > ${cutoff}
       GROUP BY am.source
       ORDER BY ratings DESC`);
    const posterior = (await this.db.get<MemoryUsefulnessRows["posterior"]>(sql`
      SELECT COUNT(*)                                                     AS "totalMemories",
             SUM(CASE WHEN alpha <> 1.0 OR beta <> 1.0 THEN 1 ELSE 0 END)  AS "movedFromPrior",
             AVG(alpha / (alpha + beta))                                  AS "avgPosteriorMean",
             AVG(CASE WHEN alpha <> 1.0 OR beta <> 1.0
                      THEN alpha / (alpha + beta) END)                    AS "avgPosteriorMeanMoved",
             SUM(CASE WHEN alpha / (alpha + beta) > ${threshold} THEN 1 ELSE 0 END) AS "aboveThreshold"
        FROM agent_memory`))!;
    const totalRetrievalRows = (await this.db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM memory_retrieval`,
    ))!.n;
    const ratingsBySource = await this.db.query<{ source: string; count: number }>(
      sql`SELECT source, COUNT(*) AS count FROM memory_rating GROUP BY source ORDER BY count DESC`,
    );
    return { volume, arms, sources, posterior, totalRetrievalRows, ratingsBySource };
  }

  // ---- memory_link ----

  abstract insertLinkIfAbsent(link: NewMemoryLink): Promise<void>;

  listContentLinks(memoryId: string): Promise<MemoryLinkIdentityRow[]> {
    return this.db.query<MemoryLinkIdentityRow>(sql`
      SELECT id, "linkType", "targetKind", "targetId", "sourceText"
        FROM memory_link
       WHERE from_memory_id = ${memoryId} AND "linkType" != 'sequel'`);
  }

  async deleteLink(id: string): Promise<void> {
    await this.db.run(sql`DELETE FROM memory_link WHERE id = ${id}`);
  }

  listOutgoingLinks(memoryId: string): Promise<MemoryOutgoingLinkRow[]> {
    return this.db.query<MemoryOutgoingLinkRow>(sql`
      SELECT ml.id, ml."linkType", ml."targetKind", ml."targetId", ml.strength,
             ml.resolver, ml."sourceText", ml."createdAt",
             m.id AS "targetMemoryId", m.name AS "targetName",
             m.scope AS "targetScope", m."agentId" AS "targetAgentId"
        FROM memory_link ml
        LEFT JOIN agent_memory m
          ON ml."targetKind" = 'memory'
         AND m.id = ml."targetId"
         AND (m."expiresAt" IS NULL OR m."expiresAt" > ${nowText})
       WHERE ml.from_memory_id = ${memoryId}
       ORDER BY ml."createdAt" ASC, ml.id ASC`);
  }

  listBacklinks(
    memoryId: string,
    visibility: { isLead: boolean; viewerAgentId: string | null },
  ): Promise<MemoryBacklinkRow[]> {
    const conditions = [
      sql`ml."targetKind" = 'memory'`,
      sql`ml."targetId" = ${memoryId}`,
      sql`(m."expiresAt" IS NULL OR m."expiresAt" > ${nowText})`,
    ];
    if (!visibility.isLead) {
      conditions.push(sql`(m."agentId" = ${visibility.viewerAgentId} OR m.scope = 'swarm')`);
    }
    return this.db.query<MemoryBacklinkRow>(sql`
      SELECT ml.id, ml."linkType", ml.strength, ml."sourceText", ml."createdAt",
             m.id AS "fromId", m.name AS "fromName", m.scope AS "fromScope"
        FROM memory_link ml
        JOIN agent_memory m ON m.id = ml.from_memory_id
       WHERE ${sqlJoin(conditions, sql` AND `)}
       ORDER BY ml."createdAt" ASC, ml.id ASC`);
  }

  async listGraphNeighbors(
    parentIds: string[],
    filter: MemoryFilter,
  ): Promise<MemoryGraphNeighborRow[]> {
    if (parentIds.length === 0) return [];
    const conditions = [
      sql`ml.from_memory_id IN (${sqlList(parentIds)})`,
      sql`ml."targetKind" = 'memory'`,
      sql`(m."expiresAt" IS NULL OR m."expiresAt" > ${nowText})`,
    ];
    this.scopeConditions(conditions, filter.agentId, filter.scope, filter.isLead, "m");
    if (filter.source) conditions.push(sql`m.source = ${filter.source}`);
    this.keyPrefixCondition(conditions, filter.keyPrefix, "m");
    return this.db.query<MemoryGraphNeighborRow>(sql`
      SELECT m.*, ml.from_memory_id AS "fromMemoryId", ml.strength AS "linkStrength"
        FROM memory_link ml
        JOIN agent_memory m ON m.id = ml."targetId"
       WHERE ${sqlJoin(conditions, sql` AND `)}`);
  }

  // ---- key browser ----

  listKeySummaries(
    prefix: string,
    visibleToAgentId: string | undefined,
    limit: number,
  ): Promise<MemoryKeySummaryRow[]> {
    const visibility =
      visibleToAgentId !== undefined
        ? sql`AND (m."agentId" = ${visibleToAgentId} OR m.scope = 'swarm')`
        : EMPTY;
    // substr/length: literal prefix match, so `%`, `_`, `*` in a key are text.
    return this.db.query<MemoryKeySummaryRow>(sql`
      WITH docs AS (
        SELECT m.*,
               ROW_NUMBER() OVER (
                 PARTITION BY m.key, m.scope, COALESCE(m."agentId", '')
                 ORDER BY m."chunkIndex", m."createdAt", m.id
               ) AS rn
          FROM agent_memory m
         WHERE m.key IS NOT NULL AND substr(m.key, 1, length(${prefix})) = ${prefix} ${visibility}
      ),
      ratings AS (
        SELECT "memoryId",
               SUM(CASE WHEN signal > 0 THEN 1 ELSE 0 END) AS useful,
               SUM(CASE WHEN signal < 0 THEN 1 ELSE 0 END) AS "notUseful"
          FROM memory_rating
         WHERE "memoryId" IN (SELECT id FROM docs)
         GROUP BY "memoryId"
      )
      SELECT d.key AS key,
             d.scope AS scope,
             MAX(d."agentId") AS "agentId",
             MAX(CASE WHEN d.rn = 1 THEN d.id END) AS "memoryId",
             MAX(CASE WHEN d.rn = 1 THEN d.name END) AS name,
             MAX(CASE WHEN d.rn = 1 THEN d.source END) AS source,
             COUNT(*) AS "chunkRows",
             MAX(d."totalChunks") AS "totalChunks",
             MIN(d."totalChunks") AS "minTotalChunks",
             COUNT(DISTINCT d."chunkIndex") AS "distinctIndexes",
             MAX(d."chunkIndex") AS "maxIndex",
             SUM(length(d.content)) AS chars,
             SUM(d."accessCount") AS "accessCount",
             MAX(d."accessedAt") AS "lastAccessedAt",
             SUM(d.alpha) AS alpha,
             SUM(d.beta) AS beta,
             COALESCE(SUM(r.useful), 0) AS "usefulRatings",
             COALESCE(SUM(r."notUseful"), 0) AS "notUsefulRatings",
             MIN(d."createdAt") AS "createdAt",
             MAX(COALESCE(d."updatedAt", d."createdAt")) AS "updatedAt"
        FROM docs d
        LEFT JOIN ratings r ON r."memoryId" = d.id
       GROUP BY d.key, d.scope, COALESCE(d."agentId", '')
       ORDER BY d.key, d.scope, COALESCE(d."agentId", '')
       LIMIT ${limit}`);
  }

  findChunkRowById(id: string): Promise<AgentMemoryRowNoEmbedding | null> {
    return this.db.get<AgentMemoryRowNoEmbedding>(
      sql`SELECT ${CHUNK_COLUMNS} FROM agent_memory WHERE id = ${id}`,
    );
  }

  listChunkRowsOfDocument(owner: MemoryDocumentOwner): Promise<AgentMemoryRowNoEmbedding[]> {
    return this.db.query<AgentMemoryRowNoEmbedding>(sql`
      SELECT ${CHUNK_COLUMNS} FROM agent_memory
       WHERE key = ${owner.key} AND scope = ${owner.scope} AND COALESCE("agentId", '') = ${owner.agentId ?? ""}
       ORDER BY "chunkIndex", "createdAt", id`);
  }

  listChunkRowsByKey(filter: {
    key: string;
    scope?: string;
    agentId?: string | null;
    visibleToAgentId?: string;
  }): Promise<AgentMemoryRowNoEmbedding[]> {
    const conditions = [sql`key = ${filter.key}`];
    if (filter.scope) conditions.push(sql`scope = ${filter.scope}`);
    if (filter.agentId !== undefined) {
      conditions.push(sql`COALESCE("agentId", '') = ${filter.agentId ?? ""}`);
    }
    if (filter.visibleToAgentId !== undefined) {
      conditions.push(sql`("agentId" = ${filter.visibleToAgentId} OR scope = 'swarm')`);
    }
    return this.db.query<AgentMemoryRowNoEmbedding>(sql`
      SELECT ${CHUNK_COLUMNS} FROM agent_memory WHERE ${sqlJoin(conditions, sql` AND `)}
       ORDER BY scope, COALESCE("agentId", ''), "chunkIndex", "createdAt", id`);
  }
}
