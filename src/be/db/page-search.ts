import { literalPrefixPattern } from "../db";

/**
 * The `AND (...)` clause for a page list's free-text `q`: the title, slug or
 * description contains it, wildcards taken literally. Pushes its values onto
 * `params`; empty when there is no `q`.
 */
export function pageSearchSql(q: string | undefined, params: (string | number)[]): string {
  if (!q) return "";
  const pattern = `%${literalPrefixPattern(q)}`;
  params.push(pattern, pattern, pattern);
  return ` AND (title LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`;
}
