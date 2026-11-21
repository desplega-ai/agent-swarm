import { getStorage } from "../storage";

// The ranked query (bm25 weights, the skills_meta_fts score multiple) lives in
// the skills repository (one per engine). On the live catalog, meta score
// multiples from 2 to 10 rank the same; 3 is mid-range.

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
 * The search terms of free text, for the skills repository's ranked search
 * (each engine builds its own full-text query from them, so user text cannot
 * inject query syntax). Stopwords are dropped and at most 12 terms are kept;
 * the terms are OR-ed: ranked recall. Returns null when no term is left, so
 * the caller falls back to the substring match.
 */
export function buildSkillSearchTerms(query: string): string[] | null {
  const terms = query
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((term) => /[\p{L}\p{N}]/u.test(term) && !STOPWORDS.has(term.toLowerCase()))
    .slice(0, 12);
  return terms.length === 0 ? null : terms;
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
  const terms = buildSkillSearchTerms(query);
  if (!terms) return [];
  const exactName = query.trim();
  try {
    return await getStorage().repos.skills.searchRankedSkills<T>(terms, exactName, limit, columns);
  } catch (err) {
    console.warn(
      "[skills-fts] ranked query failed, using substring match:",
      (err as Error).message,
    );
    return [];
  }
}
