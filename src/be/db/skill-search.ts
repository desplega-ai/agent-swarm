import { getDbClient } from "./runtime";

// bm25() takes one weight per FTS column, in declaration order.
// skills_fts (migration 239): skill_id (UNINDEXED), name, description, content.
// skills_meta_fts (migration 241): skill_id (UNINDEXED), name, description.
const SKILLS_FTS_BM25 = "bm25(skills_fts, 0.0, 3.0, 2.0, 1.0)";
const SKILLS_META_FTS_BM25 = "bm25(skills_meta_fts, 0.0, 3.0, 2.0)";

// FTS5 bm25 normalizes by the length of the whole row, so in skills_fts a
// long SKILL.md body buries a name or description hit. skills_meta_fts holds
// only those short fields; its score is added at this multiple. On the live
// catalog, multiples from 2 to 10 rank the same; 3 is mid-range.
const META_SCORE_MULTIPLE = 3;

// English function words that agents put in natural-language queries. Each
// one matches most of the catalog ("a" matched 189 of 189 skills) and only
// adds noise to the ranking.
const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do does for from get got have how i if in into is it its " +
    "me my need of on or our should so that the their them then there these this to use using " +
    "want was we what when where which who why will with would you your"
  ).split(" "),
);

/**
 * Build a skills_fts MATCH expression from free text. Every term is quoted as
 * an FTS5 string, so user text cannot inject operators (NEAR, AND, -, *, ^,
 * column filters). Stopwords are dropped and the remaining terms are OR-ed:
 * ranked recall, ordered by bm25. Returns null when no term is left, so the
 * caller falls back to the substring match.
 */
export function buildSkillsFtsMatch(query: string): string | null {
  const terms = query
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => /[\p{L}\p{N}]/u.test(term) && !STOPWORDS.has(term.toLowerCase()))
    .slice(0, 12);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

/**
 * Enabled skills ranked by BM25: the skills_fts score (name 3, description 2,
 * content 1) plus META_SCORE_MULTIPLE times the skills_meta_fts score (name 3,
 * description 2). A skill whose name equals the whole query (case-insensitive)
 * ranks first. Returns [] when the query has no indexable terms or the
 * backend cannot run the FTS query, so the caller can fall back.
 *
 * `columns` is a select list over `skills`; it must not name a bare
 * `skill_id` or `score`, which the joined `hits` and `meta` CTEs also expose.
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
       ),
       meta AS (
         SELECT skill_id, ${SKILLS_META_FTS_BM25} AS score
         FROM skills_meta_fts WHERE skills_meta_fts MATCH ?
       )
       SELECT ${columns} FROM skills
       LEFT JOIN hits ON hits.skill_id = skills.id
       LEFT JOIN meta ON meta.skill_id = skills.id
       WHERE skills.isEnabled = 1
         AND (hits.skill_id IS NOT NULL OR lower(skills.name) = lower(?))
       ORDER BY lower(skills.name) = lower(?) DESC,
         COALESCE(hits.score, 0) + ${META_SCORE_MULTIPLE} * COALESCE(meta.score, 0) ASC,
         skills.name ASC
       LIMIT ?`,
      [match, match, exactName, exactName, limit],
    );
  } catch (err) {
    console.warn(
      "[skills-fts] ranked query failed, using substring match:",
      (err as Error).message,
    );
    return [];
  }
}
