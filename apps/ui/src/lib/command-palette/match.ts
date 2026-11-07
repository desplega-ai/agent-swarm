/**
 * Cmd+K ranking and highlight. Every query word must appear in the label or
 * its keywords. A word at the start of the label ranks above one at a word
 * start, which ranks above one inside a word. A label that misses a word can
 * still match as a subsequence ("wkfl" finds "Workflows"), ranked last.
 */

/** `[start, end)` character spans of the label to highlight. */
export type Range = readonly [number, number];

export interface Match {
  score: number;
  /** Spans of the label, not of the keywords. */
  ranges: Range[];
}

const NO_QUERY: Match = { score: 0, ranges: [] };

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function isWordStart(text: string, at: number): boolean {
  return at === 0 || /[\s/_\-.:()[\]]/.test(text[at - 1] ?? "");
}

/** The best spot for `word` in `text`: a word start beats an inner hit. */
function findWord(text: string, word: string): { at: number; score: number } | null {
  let best: { at: number; score: number } | null = null;
  for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
    const score = at === 0 ? 100 : isWordStart(text, at) ? 70 : 30;
    if (!best || score > best.score) best = { at, score };
    if (score === 100) break;
  }
  return best;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

function subsequence(text: string, query: string): Range[] | null {
  const ranges: Range[] = [];
  let from = 0;
  for (const char of query) {
    const at = text.indexOf(char, from);
    if (at < 0) return null;
    ranges.push([at, at + 1]);
    from = at + 1;
  }
  return mergeRanges(ranges);
}

/** How well `label` (plus `keywords`) matches `query`. Null when it does not. */
export function matchText(
  label: string,
  query: string,
  keywords: readonly string[] = [],
): Match | null {
  const terms = words(query);
  if (terms.length === 0) return NO_QUERY;
  const text = label.toLowerCase();
  const extra = keywords.join(" ").toLowerCase();

  let score = 0;
  const ranges: Range[] = [];
  let allFound = true;
  for (const term of terms) {
    const hit = findWord(text, term);
    if (hit) {
      score += hit.score;
      ranges.push([hit.at, hit.at + term.length]);
      continue;
    }
    const inKeywords = findWord(extra, term);
    if (inKeywords) {
      score += inKeywords.score / 3;
      continue;
    }
    allFound = false;
    break;
  }
  if (allFound) {
    if (text === terms.join(" ")) score += 50;
    // Shorter labels win ties: "Tasks" above "Task templates".
    return { score: score - text.length / 100, ranges: mergeRanges(ranges) };
  }

  const fuzzy = subsequence(text, terms.join(""));
  return fuzzy ? { score: FUZZY_SCORE - text.length / 100, ranges: fuzzy } : null;
}

const FUZZY_SCORE = 5;

/** True when every query word appeared as written (not only as a subsequence). */
export function isWordMatch(match: Match | null): match is Match {
  return match !== null && match.score > FUZZY_SCORE;
}

/** A search hit the palette ranks. */
export interface Rankable {
  title: string;
  detail?: string;
  keywords?: readonly string[];
  /**
   * The server matched this row on text the row does not carry (a prompt past
   * its preview): keep it when the client matcher misses, ranked last. Only
   * an answer to the current query may set it, never a placeholder.
   */
  serverMatched?: boolean;
}

/**
 * Orders a provider's hits by `matchText`. With `clientMatch`, a hit the
 * matcher misses is dropped unless it is `serverMatched`. Without it (content
 * hits), every hit is kept in server order.
 */
export function rankResults<T extends Rankable>(
  results: readonly T[],
  query: string,
  clientMatch: boolean,
): Array<{ result: T; match: Match }> {
  const out: Array<{ result: T; match: Match }> = [];
  for (const result of results) {
    const match = matchText(result.title, query, [result.detail ?? "", ...(result.keywords ?? [])]);
    if (match) out.push({ result, match });
    // Matched on the server; keep it, with no title highlight.
    else if (!clientMatch || result.serverMatched)
      out.push({ result, match: { score: 0, ranges: [] } });
  }
  return clientMatch ? out.sort((a, b) => b.match.score - a.match.score) : out;
}

/** Splits `text` into plain and highlighted parts. */
export function highlightParts(text: string, ranges: readonly Range[]) {
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push({ text: text.slice(at, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}
