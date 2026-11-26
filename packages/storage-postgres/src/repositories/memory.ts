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
 * the migration chain; Postgres has both in the chain:
 *
 * - full text: the table `memory_fts` (migration 386), one stored tsvector and
 *   token count per memory, GIN-indexed. The memory store writes it through the
 *   FTS row methods below in the transaction that writes the memory, as on
 *   SQLite; the foreign key drops a row with its memory. A search never runs
 *   to_tsvector on stored text.
 * - vectors: the `memory_vec` table (pgvector, no fixed dimension, migration
 *   369), searched by exact k-NN on cosine distance, as sqlite-vec's brute force.
 */

/** A query term with the punctuation of the indexed text turned into spaces. */
function ftsTermText(term: string): SqlQuery {
  return sql`memory_fts_text(CAST(${term} AS text))`;
}

/** Each quoted lexeme of a tsquery's text form, for `regexp_replace` (a bound value). */
const TSQUERY_LEXEME = "('(?:[^']|'')*')";

/**
 * A phrase query restricted to one field: every word with the name weight (B)
 * or every word with the content weight (D). The stored document puts the
 * first content word right after the last name word, so an unweighted phrase
 * would match across the boundary; FTS5 keeps a phrase inside one column.
 */
function fieldPhrase(query: SqlQuery): SqlQuery {
  const weighted = (weight: string) =>
    sql`regexp_replace(${query}::text, ${TSQUERY_LEXEME}, ${`\\1:${weight}`}, 'g')`;
  return sql`(${weighted("B")} || ' | ' || ${weighted("D")})::tsquery`;
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
    // k1 = 1.2, b = 0.75, with the average document length of the whole index.
    // N and each n count every indexed memory, as FTS5 counts every index row.
    // One approximation: a multi-word term's frequency is the least frequency
    // of its words. rank is minus the score, so ascending is best first, as
    // bm25(); the id breaks rank ties.
    //
    // Cost: the GIN index finds the matching documents, and one setweight and
    // ts_filter per document keeps only the query's lexemes, so the per-row
    // work does not grow with the document. Set operations do the rest.
    const termRows = terms.map((term, i) => sql`(${i}, ${ftsTermText(term)})`);
    const conditions = this.searchConditions([sql`f.doc @@ q.query`], filter, "m");
    const float = (value: SqlQuery) => sql`CAST(${value} AS double precision)`;
    return this.via(reader).query<AgentMemoryRow & { rank: number }>(sql`
      WITH parsed AS (
        SELECT v.i, phraseto_tsquery('memory_english'::regconfig, v.text) AS query,
               tsvector_to_array(to_tsvector('memory_english'::regconfig, v.text)) AS lexemes
          FROM (VALUES ${sqlJoin(termRows, sql`, `)}) AS v(i, text)
      ),
      term AS MATERIALIZED (
        SELECT i, lexemes, numnode(query) > 1 AS phrase,
               CASE WHEN numnode(query) > 1 THEN ${fieldPhrase(sql`query`)} ELSE query END AS query
          FROM parsed
         WHERE numnode(query) > 0
      ),
      df AS MATERIALIZED (
        SELECT t.i, ${float(sql`(SELECT COUNT(*) FROM memory_fts a WHERE a.doc @@ t.query)`)} AS n
          FROM term t
      ),
      stats AS MATERIALIZED (
        SELECT ${float(sql`COUNT(*)`)} AS total, ${float(sql`AVG(doc_len)`)} AS avglen FROM memory_fts
      ),
      q AS MATERIALIZED (
        SELECT (SELECT array_agg(DISTINCT l.lexeme) FROM term, unnest(term.lexemes) AS l(lexeme)) AS lexemes,
               (SELECT string_agg('(' || CAST(query AS text) || ')', ' | ')::tsquery FROM term) AS query
      ),
      hit AS MATERIALIZED (
        SELECT f.memory_id, f.doc_len,
               ts_filter(setweight(f.doc, 'A', q.lexemes), '{a}') AS lexemes
          FROM q CROSS JOIN memory_fts f JOIN agent_memory m ON m.id = f.memory_id
         WHERE ${sqlJoin(conditions, sql` AND `)}
      ),
      occurrence AS (
        SELECT h.memory_id, h.doc_len, u.lexeme, COALESCE(array_length(u.positions, 1), 1) AS f
          FROM hit h CROSS JOIN LATERAL unnest(h.lexemes) u
      ),
      phrase_hit AS (
        SELECT o.memory_id, o.doc_len, t.i, MIN(o.f) AS f, COUNT(*) AS words
          FROM occurrence o JOIN term t ON t.phrase AND o.lexeme = ANY (t.lexemes)
         GROUP BY o.memory_id, o.doc_len, t.i
      ),
      tf AS (
        SELECT o.memory_id, o.doc_len, t.i, o.f
          FROM occurrence o JOIN term t ON NOT t.phrase AND o.lexeme = t.lexemes[1]
        UNION ALL
        SELECT p.memory_id, p.doc_len, p.i, p.f
          FROM phrase_hit p
          JOIN term t ON t.i = p.i AND p.words = cardinality(t.lexemes)
          JOIN memory_fts f ON f.memory_id = p.memory_id AND f.doc @@ t.query
      ),
      score AS (
        SELECT tf.memory_id, SUM(
                 GREATEST(ln((s.total - df.n + 0.5) / (df.n + 0.5)), 1e-6)
                 * ${float(sql`tf.f`)} * 2.2
                 / (${float(sql`tf.f`)} + 1.2 * (0.25 + 0.75 * ${float(sql`tf.doc_len`)} / s.avglen))) AS score
          FROM tf JOIN df ON df.i = tf.i CROSS JOIN stats s
         GROUP BY tf.memory_id
      ),
      top AS (
        SELECT memory_id, score FROM score ORDER BY score DESC, memory_id LIMIT ${limit}
      )
      SELECT m.*, -top.score AS rank
        FROM top JOIN agent_memory m ON m.id = top.memory_id
       ORDER BY rank, m.id`);
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
       WHERE schemaname = current_schema() AND indexname = 'idx_memory_fts_doc'`);
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
    afterRowid: number,
    limit: number,
  ): Promise<{ rowid: number; memoryId: string | null; orphan: number }[]> {
    // memory_fts has no rowid of its own: its rows come in the order of their
    // memory's rowid. The foreign key deletes a row with its memory, so none is
    // an orphan.
    const rows = await this.db.query<{ position: number; memoryId: string }>(sql`
      SELECT m."_rowid" AS position, f.memory_id AS "memoryId"
        FROM memory_fts f JOIN agent_memory m ON m.id = f.memory_id
       WHERE m."_rowid" > ${afterRowid} ORDER BY m."_rowid" LIMIT ${limit}`);
    return rows.map((row) => ({ rowid: row.position, memoryId: row.memoryId, orphan: 0 }));
  }

  async deleteFtsRowsByRowid(rowids: number[]): Promise<void> {
    if (rowids.length === 0) return;
    await this.db.run(sql`
      DELETE FROM memory_fts WHERE memory_id IN (
        SELECT id FROM agent_memory WHERE "_rowid" IN (${sqlList(rowids)}))`);
  }

  async scanMemoryIdBatch(
    afterRowid: number,
    limit: number,
  ): Promise<{ rowid: number; id: string }[]> {
    const rows = await this.db.query<{ position: number; id: string }>(sql`
      SELECT "_rowid" AS position, id FROM agent_memory
      WHERE "_rowid" > ${afterRowid} ORDER BY "_rowid" LIMIT ${limit}`);
    return rows.map((row) => ({ rowid: row.position, id: row.id }));
  }

  // The document functions are in migration 386: memory_fts_document builds
  // the stored tsvector, memory_fts_length counts its tokens. db-copy fills
  // memory_fts with the same functions.

  async insertMissingFtsRows(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.run(sql`
      INSERT INTO memory_fts (memory_id, doc, doc_len)
      SELECT s.id, s.doc, memory_fts_length(s.doc)
        FROM (SELECT m.id, memory_fts_document(m.name, m.content) AS doc
                FROM agent_memory m
               WHERE m.id IN (${sqlList(ids)})
                 AND NOT EXISTS (SELECT 1 FROM memory_fts f WHERE f.memory_id = m.id)) s
      ON CONFLICT (memory_id) DO NOTHING`);
  }

  async deleteFtsRow(memoryId: string): Promise<void> {
    await this.db.run(sql`DELETE FROM memory_fts WHERE memory_id = ${memoryId}`);
  }

  async insertFtsRow(memoryId: string, name: string, content: string): Promise<void> {
    // An upsert: the row replaces the document a concurrent backfill may have
    // written for the old text.
    await this.db.run(sql`
      INSERT INTO memory_fts (memory_id, doc, doc_len)
      SELECT ${memoryId}, s.doc, memory_fts_length(s.doc)
        FROM (SELECT memory_fts_document(CAST(${name} AS text), CAST(${content} AS text)) AS doc) s
      ON CONFLICT (memory_id) DO UPDATE SET doc = EXCLUDED.doc, doc_len = EXCLUDED.doc_len`);
  }

  async deleteFtsRows(memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) return;
    await this.db.run(sql`DELETE FROM memory_fts WHERE memory_id IN (${sqlList(memoryIds)})`);
  }

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
