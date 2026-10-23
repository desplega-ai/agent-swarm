import { getDbClient } from "./runtime";

// bm25() takes one weight per skills_fts column, in declaration order
// (migration 239): skill_id (UNINDEXED), name, description, content.
const SKILLS_FTS_BM25 = "bm25(skills_fts, 0.0, 3.0, 2.0, 1.0)";

/**
 * Build a skills_fts MATCH expression from free text. Every term is quoted as
 * an FTS5 string, so user text cannot inject operators (NEAR, AND, -, *, ^,
 * column filters). Terms are OR-ed: ranked recall, ordered by bm25.
 */
export function buildSkillsFtsMatch(query: string): string | null {
  const terms = query
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => /[\p{L}\p{N}]/u.test(term))
    .slice(0, 12);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

/**
 * Enabled skills ranked by BM25 over skills_fts (name 3, description 2,
 * content 1). A skill whose name equals the whole query (case-insensitive)
 * ranks first. Returns [] when the query has no indexable terms or the
 * backend cannot run the FTS query, so the caller can fall back.
 *
 * `columns` is a select list over `skills`; it must not name a bare
 * `skill_id` or `score`, which the joined `hits` CTE also exposes.
 */
export async function searchSkillRowsRanked<T>(
  query: string,
  limit: number,
  columns: string,
): Promise<T[]> {
  const match = buildSkillsFtsMatch(query);
  if (!match) return [];
  const exactName = query.trim();
  try {
    return await getDbClient().query<T>(
      `WITH hits AS (
         SELECT skill_id, ${SKILLS_FTS_BM25} AS score FROM skills_fts WHERE skills_fts MATCH ?
       )
       SELECT ${columns} FROM skills
       LEFT JOIN hits ON hits.skill_id = skills.id
       WHERE skills.isEnabled = 1
         AND (hits.skill_id IS NOT NULL OR lower(skills.name) = lower(?))
       ORDER BY lower(skills.name) = lower(?) DESC, hits.score ASC, skills.name ASC
       LIMIT ?`,
      [match, exactName, exactName, limit],
    );
  } catch (err) {
    console.warn(
      "[skills-fts] ranked query failed, using substring match:",
      (err as Error).message,
    );
    return [];
  }
}
