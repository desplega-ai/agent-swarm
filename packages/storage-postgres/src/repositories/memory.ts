import {
  type AgentMemoryRow,
  BaseMemoryRepository,
  isConstraintViolation,
  jsonText,
  type MemoryHealthCountsRow,
  type MemoryReadExecutor,
  type MemorySearchFilter,
  type NewMemoryLink,
  type ReviewTaskRule,
  SqlQuery,
  sql,
  sqlJoin,
  sqlList,
} from "@desplega/storage";

/**
 * Memory search on Postgres (milestone M4, decision D15). SQLite keeps
 * `memory_fts` (FTS5) and `memory_vec` (sqlite-vec) as run-time tables outside
 * the migration chain; migration 369 gives Postgres:
 *
 * - full text: an expression GIN index on agent_memory (`idx_agent_memory_fts`),
 *   which stays in sync by itself. There are no index rows of its own, so the
 *   FTS row writes are no-ops and the backfill scan finds nothing.
 * - vectors: the `memory_vec` table (pgvector, no fixed dimension), searched by
 *   exact k-NN on cosine distance, as sqlite-vec's brute force.
 */

/** The indexed document: the expression of `idx_agent_memory_fts`, written exactly as the index. */
function ftsDocument(alias: string): SqlQuery {
  const p = alias ? `${alias}.` : "";
  return new SqlQuery(
    [
      `(to_tsvector('memory_english'::regconfig, memory_fts_text(${p}"name"))
        || to_tsvector('memory_english'::regconfig, memory_fts_text(${p}"content")))`,
    ],
    [],
  );
}

/** One field's text vector (the index concatenates the name and content vectors). */
function ftsField(alias: string, column: "name" | "content"): SqlQuery {
  const p = alias ? `${alias}.` : "";
  return new SqlQuery(
    [`to_tsvector('memory_english'::regconfig, memory_fts_text(${p}"${column}"))`],
    [],
  );
}

/**
 * `query` matches one memory: the indexed concatenation prefilters (it uses
 * the GIN index), and the field recheck keeps a phrase inside one field, as
 * FTS5 does. The concatenation puts the first content word right after the
 * last name word, so a phrase alone would match across the boundary.
 */
function ftsMatch(alias: string, query: SqlQuery): SqlQuery {
  return sql`(${ftsDocument(alias)} @@ ${query} AND (${ftsField(alias, "name")} @@ ${query} OR ${ftsField(alias, "content")} @@ ${query}))`;
}

/** A query term with the punctuation of the indexed text turned into spaces. */
function ftsTermText(term: string): SqlQuery {
  return sql`memory_fts_text(CAST(${term} AS text))`;
}

/** One term as a phrase query, as FTS5's `"term"`. */
function phraseQuery(term: string): SqlQuery {
  return sql`phraseto_tsquery('memory_english'::regconfig, ${ftsTermText(term)})`;
}

/** Any of `terms`, each a phrase, as FTS5's `"t1" OR "t2"`. */
function ftsQuery(terms: string[]): SqlQuery {
  return sqlJoin(terms.map(phraseQuery), sql` || `);
}

/** The float32 elements of a little-endian embedding blob. */
function float32s(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
    throw new Error(`embedding blob of ${bytes.byteLength} bytes is not a float32 vector`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** A float32 blob as a pgvector value (the text form round-trips each float32 exactly). */
function vectorValue(bytes: Uint8Array): SqlQuery {
  return sql`CAST(${`[${Array.from(float32s(bytes)).join(",")}]`} AS vector)`;
}

/**
 * sqlite-vec's `1 - vec_distance_cosine(a, b)`: float32 sums, a double quotient,
 * the distance rounded to float32. A zero vector gives NaN (SQLite NULL), which
 * fails any floor.
 */
function cosineSimilarityF32(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot = Math.fround(dot + Math.fround(ai * bi));
    aMag = Math.fround(aMag + Math.fround(ai * ai));
    bMag = Math.fround(bMag + Math.fround(bi * bi));
  }
  return 1 - Math.fround(1 - dot / (Math.sqrt(aMag) * Math.sqrt(bMag)));
}

export class PostgresMemoryRepository extends BaseMemoryRepository {
  protected insertionOrder(): SqlQuery {
    return new SqlQuery(['"_rowid"'], []);
  }

  protected notReviewTaskCompletion(alias: string, rule: ReviewTaskRule): SqlQuery {
    const p = this.prefix(alias);
    // Only string elements of an array count as tags, as SQLite's json_each
    // over a JSON array compared with text.
    return sql`NOT (${p}source = 'task_completion' AND EXISTS (
            SELECT 1 FROM agent_tasks rt
            WHERE rt.id = ${p}"sourceTaskId"
              AND (rt."taskType" = ${rule.taskType}
                OR (jsonb_typeof(rt.tags) = 'array' AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(rt.tags) AS tag(value)
                  WHERE jsonb_typeof(tag.value) = 'string'
                    AND tag.value #>> '{}' IN (${sqlList(rule.tags)}))))))`;
  }

  // ---- search arms ----

  async searchFtsRows(
    terms: string[],
    filter: MemorySearchFilter,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<(AgentMemoryRow & { rank: number })[]> {
    if (terms.length === 0) return [];
    // FTS5's bm25() over the same statistics, so the order follows the same
    // rules (rare terms weigh more, term frequency saturates, long documents
    // weigh less): idf = ln((N - n + 0.5) / (n + 0.5)), floored at 1e-6, and
    // k1 = 1.2, b = 0.75. N and each n count every memory, as FTS5 counts every
    // index row. Two approximations: a multi-word term's frequency is the least
    // frequency of its words, and the average length is over the matching rows
    // (FTS5 keeps it for the whole index; reading every row here costs a full
    // scan). rank is minus the score, so ascending is best first, as bm25();
    // the id breaks rank ties.
    const termRows = terms.map(
      (term, i) =>
        sql`(${i}, ${phraseQuery(term)}, tsvector_to_array(to_tsvector('memory_english'::regconfig, ${ftsTermText(term)})))`,
    );
    const conditions = this.searchConditions(
      [ftsMatch("m", sql`(SELECT ${ftsQuery(terms)})`)],
      filter,
      "m",
    );
    return this.via(reader).query<AgentMemoryRow & { rank: number }>(sql`
      WITH term AS MATERIALIZED (
        SELECT t.i, t.query, t.lexemes,
               (SELECT COUNT(*) FROM agent_memory a WHERE ${ftsMatch("a", sql`t.query`)}) AS n
          FROM (VALUES ${sqlJoin(termRows, sql`, `)}) AS t(i, query, lexemes)
      ),
      matched AS MATERIALIZED (
        SELECT m.id, ${ftsDocument("m")} AS doc, ${ftsField("m", "name")} AS name_doc,
               ${ftsField("m", "content")} AS content_doc
          FROM agent_memory m
         WHERE ${sqlJoin(conditions, sql` AND `)}
      ),
      hit AS MATERIALIZED (
        SELECT id, doc, name_doc, content_doc,
               (SELECT SUM(COALESCE(array_length(u.positions, 1), 1)) FROM unnest(doc) u) AS len
          FROM matched
      ),
      stats AS (
        SELECT (SELECT COUNT(*) FROM agent_memory) AS total,
               (SELECT AVG(len) FROM hit) AS avglen
      ),
      score AS (
        SELECT hit.id, SUM(
                 GREATEST(ln((stats.total - term.n + 0.5) / (term.n + 0.5)), 1e-6)
                 * tf.f * 2.2 / (tf.f + 1.2 * (0.25 + 0.75 * hit.len / stats.avglen))) AS score
          FROM hit CROSS JOIN stats CROSS JOIN term
          CROSS JOIN LATERAL (
            SELECT CASE WHEN hit.name_doc @@ term.query OR hit.content_doc @@ term.query
                     THEN COALESCE((SELECT MIN(COALESCE(array_length(u.positions, 1), 1))
                                      FROM unnest(hit.doc) u WHERE u.lexeme = ANY (term.lexemes)), 0)
                     ELSE 0 END AS f) tf
         GROUP BY hit.id
      )
      SELECT m.*, -score.score AS rank
        FROM score JOIN agent_memory m ON m.id = score.id
       ORDER BY rank, m.id
       LIMIT ${limit}`);
  }

  searchVecRows(
    embedding: Uint8Array,
    filter: MemorySearchFilter,
    knn: number,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<(AgentMemoryRow & { distance: number })[]> {
    // sqlite-vec takes the k nearest memory_vec rows first, then the join and
    // the filter drop rows: same here, exact (no ANN index).
    const conditions = this.searchConditions([], filter, "m");
    return this.via(reader).query<AgentMemoryRow & { distance: number }>(sql`
      SELECT m.*, v.distance
        FROM (SELECT memory_id, embedding <=> ${vectorValue(embedding)} AS distance
                FROM memory_vec
               ORDER BY distance, memory_id
               LIMIT ${knn}) v
        JOIN agent_memory m ON m.id = v.memory_id
       ${conditions.length > 0 ? sql`WHERE ${sqlJoin(conditions, sql` AND `)}` : sql``}
       ORDER BY v.distance, m.id
       LIMIT ${limit}`);
  }

  async scoreCappedRows(
    embedding: Uint8Array,
    filter: MemorySearchFilter,
    cap: number,
    floor: number,
    limit: number,
    reader?: MemoryReadExecutor,
  ): Promise<{ id: string; similarity: number }[]> {
    // agent_memory.embedding is a float32 blob (bytea), and Postgres has no
    // fast way to read it as a vector: a SQL or plpgsql decoder takes 5 to
    // 75 ms a row. The capped set (id + blob only) is scored here with
    // sqlite-vec's arithmetic instead. A row of another length scores nothing.
    const query = float32s(embedding);
    const rows = await this.listCappedEmbeddings(filter, cap, reader);
    const scored: { id: string; similarity: number }[] = [];
    for (const row of rows) {
      if (row.embedding.byteLength !== embedding.byteLength) continue;
      const similarity = cosineSimilarityF32(query, float32s(row.embedding));
      if (similarity >= floor) scored.push({ id: row.id, similarity });
    }
    scored.sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return scored.slice(0, limit);
  }

  healthCounts(
    vectorBytes: number,
    vecUsable: boolean,
    reader?: MemoryReadExecutor,
  ): Promise<MemoryHealthCountsRow | null> {
    const valid = sql`embedding IS NOT NULL AND octet_length(embedding) = ${vectorBytes}`;
    const validCount = sql`(SELECT COUNT(*) FROM agent_memory WHERE ${valid})`;
    return this.via(reader).get<MemoryHealthCountsRow>(sql`
      SELECT
        (SELECT COUNT(*) FROM agent_memory) AS total,
        (SELECT COUNT(*) FROM agent_memory WHERE embedding IS NOT NULL) AS "withEmbedding",
        ${validCount} AS "validEmbedding",
        (SELECT COUNT(*) FROM agent_memory
          WHERE embedding IS NOT NULL AND octet_length(embedding) != ${vectorBytes}) AS "invalidEmbedding",
        (SELECT COUNT(*) FROM agent_memory
          WHERE ${valid} AND ("expiresAt" IS NULL OR "expiresAt" > statement_timestamp())) AS searchable,
        ${vecUsable ? sql`(SELECT COUNT(*) FROM memory_vec)` : sql`0`} AS "memoryVec",
        ${
          vecUsable
            ? sql`${validCount}
               - (SELECT COUNT(*) FROM memory_vec v JOIN agent_memory m ON m.id = v.memory_id
                  WHERE m.embedding IS NOT NULL AND octet_length(m.embedding) = ${vectorBytes})`
            : validCount
        } AS "missingFromVec",
        ${
          vecUsable
            ? sql`(SELECT COUNT(*) FROM memory_vec v LEFT JOIN agent_memory m ON m.id = v.memory_id
                WHERE m.id IS NULL)`
            : sql`0`
        } AS "extraInVec"`);
  }

  // ---- run-time search indexes ----

  async ftsTableSchema(): Promise<string | null> {
    const row = await this.db.get<{ definition: string }>(sql`
      SELECT indexdef AS definition FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = 'idx_agent_memory_fts'`);
    return row?.definition ?? null;
  }

  async vecTableSchema(reader?: MemoryReadExecutor): Promise<string | null> {
    // Migration 369 creates the table; its columns stand for SQLite's CREATE text.
    const row = await this.via(reader).get<{ definition: string | null }>(sql`
      SELECT 'TABLE memory_vec (' || string_agg(
               a.attname || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
             || ')' AS definition
        FROM pg_attribute a
       WHERE a.attrelid = to_regclass('memory_vec') AND a.attnum > 0 AND NOT a.attisdropped`);
    return row?.definition ?? null;
  }

  async scanFtsBatch(
    _afterRowid: number,
    _limit: number,
  ): Promise<{ rowid: number; memoryId: string | null; orphan: number }[]> {
    // The expression index has no rows of its own, so none is an orphan.
    return [];
  }

  async deleteFtsRowsByRowid(_rowids: number[]): Promise<void> {}

  async scanMemoryIdBatch(
    afterRowid: number,
    limit: number,
  ): Promise<{ rowid: number; id: string }[]> {
    const rows = await this.db.query<{ position: number; id: string }>(sql`
      SELECT "_rowid" AS position, id FROM agent_memory
      WHERE "_rowid" > ${afterRowid} ORDER BY "_rowid" LIMIT ${limit}`);
    return rows.map((row) => ({ rowid: row.position, id: row.id }));
  }

  // The expression index indexes every agent_memory row as it is written, and
  // drops it with the row: the FTS row writes have nothing to do.
  async insertMissingFtsRows(_ids: string[]): Promise<void> {}

  async deleteFtsRow(_memoryId: string): Promise<void> {}

  async insertFtsRow(_memoryId: string, _name: string, _content: string): Promise<void> {}

  async deleteFtsRows(_memoryIds: string[]): Promise<void> {}

  async deleteVecRows(memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) return;
    await this.db.run(sql`DELETE FROM memory_vec WHERE memory_id IN (${sqlList(memoryIds)})`);
  }

  async deleteVecRow(memoryId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM memory_vec WHERE memory_id = ${memoryId}`);
  }

  async insertVecRow(memoryId: string, embedding: Uint8Array): Promise<void> {
    await this.db.run(
      sql`INSERT INTO memory_vec (memory_id, embedding) VALUES (${memoryId}, ${vectorValue(embedding)})`,
    );
  }

  // ---- memory_retrieval ----

  async purgeSearchRetrievalsBefore(cutoff: string, limit: number): Promise<number> {
    // Oldest first, as SQLite's plan on the retrievedAt index reads them.
    const result = await this.db.run(sql`
      DELETE FROM memory_retrieval WHERE "_rowid" IN (
        SELECT "_rowid" FROM memory_retrieval
        WHERE "eventType" = 'search' AND "retrievedAt" < ${cutoff}
        ORDER BY "retrievedAt", "_rowid" LIMIT ${limit})`);
    return result.changes;
  }

  // ---- memory_link ----

  async insertLinkIfAbsent(l: NewMemoryLink): Promise<void> {
    // SQLite's INSERT OR IGNORE skips a duplicate and also a row a CHECK or NOT
    // NULL constraint refuses. ON CONFLICT covers the duplicate; the savepoint
    // keeps a refused row from aborting the caller's transaction.
    try {
      await this.db.transaction(() =>
        this.db.run(sql`
          INSERT INTO memory_link
            (id, from_memory_id, "linkType", "targetKind", "targetId", strength, resolver, "sourceText", metadata, "createdAt", "updatedAt")
          VALUES (${l.id}, ${l.fromMemoryId}, ${l.linkType}, ${l.targetKind}, ${l.targetId}, ${l.strength}, ${l.resolver}, ${l.sourceText}, ${jsonText(l.metadata)}, ${l.now}, ${l.now})
          ON CONFLICT DO NOTHING`),
      );
    } catch (err) {
      if (isConstraintViolation(err, "check") || isConstraintViolation(err, "notNull")) return;
      throw err;
    }
  }
}
