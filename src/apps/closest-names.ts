/** Longest name worth scoring: edit distance is O(name × candidate) per candidate, so a longer name gets no suggestions. */
export const CLOSEST_NAME_MAX_LENGTH = 128;

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** The `limit` names nearest to `name`, nearest first (substring matches rank first). */
export function closestNames(name: string, names: Iterable<string>, limit = 5): string[] {
  if (name.length > CLOSEST_NAME_MAX_LENGTH) return [];
  const needle = name.toLowerCase();
  return [...names]
    .map((candidate) => {
      const lower = candidate.toLowerCase();
      const contains = lower.includes(needle) || needle.includes(lower);
      return { candidate, score: editDistance(needle, lower) - (contains ? 100 : 0) };
    })
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
