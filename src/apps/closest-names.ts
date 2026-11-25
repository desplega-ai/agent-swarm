/** Scoring budget: callers pass caller-controlled tokens and stored keys of any size. */
const MAX_SCORED_CHARS = 64;
// shortcut: only the first MAX_SCORED_NAMES keys are ranked, raise it if real apps outgrow it.
const MAX_SCORED_NAMES = 2000;

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

/**
 * The `limit` names nearest to `name`, nearest first (substring matches rank first). Both sides
 * are scored on their first 64 chars and at most 2000 names are scored, so one call costs at most
 * 2000 x 64 x 64 cells on the shared event loop, whatever the caller sends.
 */
export function closestNames(name: string, names: Iterable<string>, limit = 5): string[] {
  const needle = name.slice(0, MAX_SCORED_CHARS).toLowerCase();
  const scored: Array<{ candidate: string; score: number }> = [];
  for (const candidate of names) {
    if (scored.length >= MAX_SCORED_NAMES) break;
    const lower = candidate.slice(0, MAX_SCORED_CHARS).toLowerCase();
    const contains = lower.includes(needle) || needle.includes(lower);
    scored.push({ candidate, score: editDistance(needle, lower) - (contains ? 100 : 0) });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}
