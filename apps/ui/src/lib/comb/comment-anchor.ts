// Copied verbatim from agent-fs `live/src/lib/comment-anchor.ts` (agent-fs
// commit 08e7d89). Keep in sync with live/. Change logic upstream first.
// Only Biome formatting, one lint suppression, and the punctuation of one
// comment (no em dashes) differ from the source.

/**
 * Comment anchor resolution.
 *
 * A comment stores where it points in up to three ways: a text quote
 * ({ exact, prefix, suffix }, or the legacy 200-char `quotedContent`), a
 * source line range, and the file version it was made against. The file (or
 * the view of it) changes under the comment, so the anchor is re-resolved
 * every render, in order:
 *
 *   1. exact quote, disambiguated by prefix/suffix when it occurs more than once;
 *      an occurrence where either saved side conflicts is only accepted where
 *      the line range confirms it
 *   2. the line range, remapped from the comment's version to the current one
 *   3. the quote alone (first/nearest occurrence, or a partial match)
 *   4. "lost": surfaced to the user instead of silently highlighting nothing
 *
 * Everything here is pure and works on a `TextSpace`: the text a viewer shows
 * (Monaco's model text, or the rendered markdown's DOM text) plus optional
 * line <-> offset mapping into source lines.
 */

export interface AnchorQuote {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/** Diff entry with line numbers, as returned by the `diff` op. */
export interface AnchorDiffChange {
  type: "add" | "remove" | "context";
  oldLine?: number;
  newLine?: number;
}

export interface TextSpace {
  text: string;
  /** [start, end) offsets of source lines a..b (1-based, inclusive); null if unmappable. */
  lineRangeToOffsets?: (a: number, b: number) => [number, number] | null;
  /** Source line containing an offset; null if unknown. */
  offsetToLine?: (offset: number) => number | null;
}

export interface AnchorInput {
  quote?: AnchorQuote;
  lineStart?: number;
  lineEnd?: number;
  /** The file changed since the comment was made (its version != current). */
  stale?: boolean;
  /**
   * Diff from the comment's version to the current one, with line numbers.
   * `undefined`/`null` = not available (not fetched, old server, no versioning).
   */
  changes?: AnchorDiffChange[] | null;
}

export type AnchorStatus = "anchored" | "moved" | "lost";

export interface AnchorResolution {
  status: AnchorStatus;
  /** How the anchor was found. */
  method?: "quote" | "lines" | "quote-partial";
  /** [start, end) offsets in the TextSpace text. */
  start?: number;
  end?: number;
  /** Current source lines, when the space can map offsets to lines. */
  lineStart?: number;
  lineEnd?: number;
  /** The quote occurs more than once and nothing singled out one occurrence. */
  ambiguous?: boolean;
}

/** Chars of context captured on each side of a selection. */
export const QUOTE_CONTEXT_CHARS = 32;
/** Longest `exact` a client sends. The server caps at 4000. */
export const QUOTE_EXACT_MAX = 2000;
/** Partial fallback: match this many normalized chars from each end of the quote. */
const PARTIAL_CHARS = 32;
const MAX_CANDIDATES = 500;

// --- Normalization ---------------------------------------------------------

type Mode = "strict" | "loose";

interface Normalized {
  norm: string;
  /** norm index -> original index */
  map: number[];
}

// Markdown syntax that is in the source but not in the rendered text. Dropping
// it (plus all whitespace and case) lets a quote taken from the rendered view
// match the source and vice versa.
const LOOSE_DROP = /[\s*_`~#>|\\[\]]/;

/**
 * strict: collapse whitespace runs to one space (case-sensitive).
 * loose: drop whitespace and markdown syntax chars, lowercase.
 */
function normalize(text: string, mode: Mode): Normalized {
  let norm = "";
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (mode === "strict") {
      if (/\s/.test(ch)) {
        if (!inSpace) {
          norm += " ";
          map.push(i);
        }
        inSpace = true;
        continue;
      }
      inSpace = false;
      norm += ch;
      map.push(i);
    } else {
      if (LOOSE_DROP.test(ch)) continue;
      const lower = ch.toLowerCase();
      for (let k = 0; k < lower.length; k++) {
        norm += lower[k];
        map.push(i);
      }
    }
  }
  return { norm, map };
}

function normalizeNeedle(text: string, mode: Mode): string {
  const n = normalize(text, mode).norm;
  return mode === "strict" ? n.trim() : n;
}

// Every comment searches the same document text in both modes: keep the last one.
let hayCache: { text: string; strict?: Normalized; loose?: Normalized } = { text: "" };

function normalizeHay(text: string, mode: Mode): Normalized {
  if (hayCache.text !== text) hayCache = { text };
  // biome-ignore lint/suspicious/noAssignInExpressions: verbatim copy of live/, logic stays upstream.
  return (hayCache[mode] ??= normalize(text, mode));
}

// --- Candidate search --------------------------------------------------------

interface Candidate {
  start: number;
  end: number;
  /** Found without markdown/case normalization. */
  strict?: boolean;
}

function findAll(hay: Normalized, needle: string): Candidate[] {
  const out: Candidate[] = [];
  if (!needle) return out;
  let from = 0;
  while (out.length < MAX_CANDIDATES) {
    const i = hay.norm.indexOf(needle, from);
    if (i < 0) break;
    out.push({ start: hay.map[i], end: hay.map[i + needle.length - 1] + 1 });
    from = i + 1;
  }
  return out;
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

// Context is compared on letters and digits only, so markup that differs
// between the rendered view and the source (emphasis, list markers, blank
// lines, link targets) doesn't read as a change.
function contextKey(text: string): string {
  return text
    .replace(/\]\([^)\s]*\)?/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** Stray chars (a list number, a link target) either side may skip at the join. */
const CONTEXT_SKIP = 3;
/** Shorter saved context (after contextKey) says nothing either way. */
const CONTEXT_MIN = 3;

/** Chars of `want` matching `got` outward from the quote, allowing a few stray chars. */
function sideMatch(want: string, got: string, side: "prefix" | "suffix"): number {
  let best = 0;
  for (let a = 0; a <= CONTEXT_SKIP; a++) {
    for (let b = 0; b <= CONTEXT_SKIP; b++) {
      const n =
        side === "prefix"
          ? commonSuffixLength(want.slice(0, want.length - a), got.slice(0, got.length - b))
          : commonPrefixLength(want.slice(a), got.slice(b));
      if (n > best) best = n;
    }
  }
  return best;
}

interface ContextMatch {
  score: number;
  /**
   * Some saved context side disagrees with this occurrence. One agreeing side
   * doesn't outweigh it: duplicated text often shares one side (the same line
   * after it) while the other side is what tells the occurrences apart.
   */
  conflicts: boolean;
}

/** How well the text around a candidate matches the stored prefix/suffix. */
function contextMatch(text: string, c: Candidate, quote: AnchorQuote): ContextMatch {
  let score = 0;
  let disagrees = false;
  for (const side of ["prefix", "suffix"] as const) {
    const saved = quote[side];
    if (!saved) continue;
    const want = contextKey(saved);
    const window =
      side === "prefix"
        ? text.slice(Math.max(0, c.start - saved.length * 3), c.start)
        : text.slice(c.end, c.end + saved.length * 3);
    const n = sideMatch(want, contextKey(window), side);
    score += n;
    if (want.length < CONTEXT_MIN) continue;
    // Half of what was saved, or the 8 chars nearest the quote.
    if (n < Math.min(want.length, Math.max(8, Math.ceil(want.length / 2)))) disagrees = true;
  }
  return { score, conflicts: disagrees };
}

/** The candidate with the strictly best context score (strict matches win ties), if there is one. */
function pickByContext(text: string, cands: Candidate[], quote: AnchorQuote): Candidate | null {
  if (!quote.prefix && !quote.suffix) return null;
  let best: Candidate | null = null;
  let bestScore = 0;
  let tie = false;
  for (const c of cands) {
    const s = contextMatch(text, c, quote).score;
    if (s > bestScore || (s === bestScore && s > 0 && c.strict && !best?.strict)) {
      best = c;
      bestScore = s;
      tie = false;
    } else if (s === bestScore && s > 0 && c.strict === best?.strict) tie = true;
  }
  return best && !tie ? best : null;
}

function pickNearestLine(space: TextSpace, cands: Candidate[], line: number): Candidate | null {
  if (!space.offsetToLine) return null;
  let best: Candidate | null = null;
  let bestDist = Infinity;
  for (const c of cands) {
    const l = space.offsetToLine(c.start);
    if (l == null) continue;
    const d = Math.abs(l - line);
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Occurrences of the quote, strict and markdown-normalized together: the one
 * the context points at may only match normalized (a quote taken in the
 * rendered view, read in the source), while another occurrence matches as is.
 */
function findQuote(space: TextSpace, needle: string): Candidate[] {
  const find = (mode: Mode) => {
    const n = normalizeNeedle(needle, mode);
    return n ? findAll(normalizeHay(space.text, mode), n) : [];
  };
  const strict = find("strict").map((c) => ({ ...c, strict: true }));
  const loose = find("loose").filter(
    (c) => !strict.some((s) => s.start < c.end && c.start < s.end),
  );
  return [...strict, ...loose].sort((a, b) => a.start - b.start);
}

function overlapsLines(
  space: TextSpace,
  c: Candidate,
  lines: { lineStart: number; lineEnd: number },
): boolean {
  const a = space.offsetToLine?.(c.start);
  const b = space.offsetToLine?.(Math.max(c.start, c.end - 1));
  return a != null && b != null && a <= lines.lineEnd && b >= lines.lineStart;
}

/**
 * Quote-only fallback when the full quote is gone: look for its first and
 * last PARTIAL_CHARS (normalized). If both survive in order, span them.
 */
function findPartial(space: TextSpace, quote: AnchorQuote, lineHint?: number): Candidate | null {
  const needle = normalizeNeedle(quote.exact, "loose");
  if (needle.length <= PARTIAL_CHARS) return null;
  const hay = normalizeHay(space.text, "loose");
  const pick = (cands: Candidate[]) =>
    cands.length === 1
      ? cands[0]
      : (pickByContext(space.text, cands, quote) ??
        (lineHint != null ? pickNearestLine(space, cands, lineHint) : null) ??
        cands[0] ??
        null);
  const head = pick(findAll(hay, needle.slice(0, PARTIAL_CHARS)));
  const tail = pick(findAll(hay, needle.slice(-PARTIAL_CHARS)));
  if (
    head &&
    tail &&
    tail.start >= head.end &&
    tail.end - head.start <= space.text.length &&
    tail.start - head.end <= quote.exact.length * 2
  ) {
    return { start: head.start, end: tail.end };
  }
  return head ?? tail;
}

// --- Line remapping ----------------------------------------------------------

/** Whether a diff carries line numbers (older servers return content-only changes). */
export function diffHasLineNumbers(changes: AnchorDiffChange[]): boolean {
  return changes.length === 0 || changes.some((c) => c.oldLine != null || c.newLine != null);
}

function remapLine(changes: AnchorDiffChange[], line: number): { line: number; removed: boolean } {
  let delta = 0;
  let lastNew = 0;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c.newLine != null) lastNew = Math.max(lastNew, c.newLine);
    if (c.oldLine == null) continue;
    if (c.oldLine < line) {
      if (c.type === "context" && c.newLine != null) delta = c.newLine - c.oldLine;
      continue;
    }
    if (c.oldLine === line) {
      if (c.type === "context" && c.newLine != null) return { line: c.newLine, removed: false };
      // Removed: land on the next line that exists in the new version.
      for (let j = i + 1; j < changes.length; j++) {
        const n = changes[j].newLine;
        if (n != null) return { line: n, removed: true };
      }
      return { line: Math.max(1, lastNew + 1), removed: true };
    }
    break; // past `line`: it sits in an unchanged stretch after the last hunk seen
  }
  return { line: line + delta, removed: false };
}

/**
 * Map an old line range through a diff. `touched` = any line in the range was
 * removed or something was inserted inside it; `deleted` = every line is gone.
 */
export function remapLineRange(
  changes: AnchorDiffChange[],
  lineStart: number,
  lineEnd: number,
): { lineStart: number; lineEnd: number; touched: boolean; deleted: boolean } {
  const a = remapLine(changes, lineStart);
  const b = remapLine(changes, lineEnd);
  const removedInRange = changes.filter(
    (c) =>
      c.type === "remove" && c.oldLine != null && c.oldLine >= lineStart && c.oldLine <= lineEnd,
  ).length;
  const start = a.line;
  const end = Math.max(start, b.removed ? b.line - 1 : b.line);
  const insertedInside = changes.some(
    (c) => c.type === "add" && c.newLine != null && c.newLine > start && c.newLine <= end,
  );
  if (removedInRange === lineEnd - lineStart + 1) {
    // Every line was removed. If the same change block added lines, the range
    // was rewritten in place: point at the replacement instead of losing it.
    const first = changes.findIndex((c) => c.type === "remove" && c.oldLine === lineStart);
    const last = changes.findIndex((c) => c.type === "remove" && c.oldLine === lineEnd);
    let lo = first;
    let hi = last;
    while (lo > 0 && changes[lo - 1].type !== "context") lo--;
    while (hi >= 0 && hi < changes.length - 1 && changes[hi + 1].type !== "context") hi++;
    const added =
      first < 0 || last < 0
        ? []
        : changes
            .slice(lo, hi + 1)
            .flatMap((c) => (c.type === "add" && c.newLine != null ? [c.newLine] : []));
    if (added.length) {
      return {
        lineStart: Math.min(...added),
        lineEnd: Math.max(...added),
        touched: true,
        deleted: false,
      };
    }
    return { lineStart: start, lineEnd: start, touched: true, deleted: true };
  }
  return {
    lineStart: start,
    lineEnd: Math.max(start, end),
    touched: removedInRange > 0 || insertedInside,
    deleted: false,
  };
}

// --- Resolution --------------------------------------------------------------

function withLines(space: TextSpace, r: AnchorResolution): AnchorResolution {
  if (r.start == null || r.end == null || !space.offsetToLine || r.lineStart != null) return r;
  const lineStart = space.offsetToLine(r.start) ?? undefined;
  const lineEnd = space.offsetToLine(Math.max(r.start, r.end - 1)) ?? undefined;
  return { ...r, lineStart, lineEnd };
}

export function resolveAnchor(space: TextSpace, input: AnchorInput): AnchorResolution {
  const quote = input.quote?.exact?.trim() ? input.quote : undefined;

  // Lines we can trust in the current version: as stored when the file hasn't
  // changed, remapped through the diff when it has, unknown otherwise.
  let lines: { lineStart: number; lineEnd: number; touched: boolean; deleted: boolean } | null =
    null;
  if (input.lineStart != null && input.lineStart > 0) {
    const end = Math.max(input.lineStart, input.lineEnd ?? input.lineStart);
    if (!input.stale)
      lines = { lineStart: input.lineStart, lineEnd: end, touched: false, deleted: false };
    else if (input.changes && diffHasLineNumbers(input.changes))
      lines = remapLineRange(input.changes, input.lineStart, end);
  }

  // 1. Exact quote, disambiguated by prefix/suffix. Occurrences whose saved
  // context conflicts (e.g. the only one left after the commented duplicate
  // was edited) are held back until the line range can confirm them.
  let ambiguous: Candidate[] = [];
  let conflicting: Candidate[] = [];
  if (quote) {
    const all = findQuote(space, quote.exact);
    let cands: Candidate[];
    if (quote.prefix || quote.suffix) {
      const conflicts = new Set(all.filter((c) => contextMatch(space.text, c, quote).conflicts));
      cands = all.filter((c) => !conflicts.has(c));
      conflicting = [...conflicts];
    } else {
      // No context (legacy quote): an as-is match beats a normalized one.
      const strict = all.filter((c) => c.strict);
      cands = strict.length ? strict : all;
    }
    const picked = cands.length === 1 ? cands[0] : pickByContext(space.text, cands, quote);
    if (picked)
      return withLines(space, {
        status: "anchored",
        method: "quote",
        start: picked.start,
        end: picked.end,
      });
    ambiguous = cands;
  }

  // 2. Line range (remapped to the current version).
  if (lines && !lines.deleted) {
    if (ambiguous.length) {
      const near = pickNearestLine(space, ambiguous, lines.lineStart);
      if (near)
        return withLines(space, {
          status: "anchored",
          method: "quote",
          start: near.start,
          end: near.end,
        });
    }
    const confirmed = conflicting.find((c) => overlapsLines(space, c, lines));
    if (confirmed)
      return withLines(space, {
        status: "anchored",
        method: "quote",
        start: confirmed.start,
        end: confirmed.end,
      });
    const offsets = space.lineRangeToOffsets?.(lines.lineStart, lines.lineEnd);
    if (offsets) {
      return {
        status: lines.touched ? "moved" : "anchored",
        method: "lines",
        start: offsets[0],
        end: offsets[1],
        lineStart: lines.lineStart,
        lineEnd: lines.lineEnd,
      };
    }
  }

  // 3. Quote only: an occurrence we couldn't single out, or a partial match.
  if (quote) {
    if (ambiguous.length) {
      const c =
        (input.lineStart != null ? pickNearestLine(space, ambiguous, input.lineStart) : null) ??
        ambiguous[0];
      return withLines(space, {
        status: "anchored",
        method: "quote",
        start: c.start,
        end: c.end,
        ambiguous: true,
      });
    }
    if (conflicting.length) {
      // Its original lines are gone: the survivors are other occurrences.
      if (lines?.deleted) return { status: "lost" };
      // Position unknown (no diff, or unmappable lines): best guess, flagged.
      const c =
        (input.lineStart != null
          ? pickNearestLine(space, conflicting, lines?.lineStart ?? input.lineStart)
          : null) ?? conflicting[0];
      return withLines(space, { status: "moved", method: "quote", start: c.start, end: c.end });
    }
    const partial = findPartial(space, quote, lines?.lineStart ?? input.lineStart);
    if (partial)
      return withLines(space, {
        status: "moved",
        method: "quote-partial",
        start: partial.start,
        end: partial.end,
      });
  }

  // The file changed and we couldn't verify anything: keep today's behaviour
  // (stored lines) but flag it, instead of silently decorating stale lines.
  if (!quote && input.stale && !lines && input.lineStart != null && input.lineStart > 0) {
    const end = Math.max(input.lineStart, input.lineEnd ?? input.lineStart);
    const offsets = space.lineRangeToOffsets?.(input.lineStart, end);
    if (offsets)
      return {
        status: "moved",
        method: "lines",
        start: offsets[0],
        end: offsets[1],
        lineStart: input.lineStart,
        lineEnd: end,
      };
  }

  // 4. Lost.
  return { status: "lost" };
}

/**
 * Resolve in a view whose lines aren't the file's source lines (JSON shown
 * formatted). A quote resolves in the view directly; failing that, the
 * comment resolves in the source with its line range, and the source text it
 * lands on is carried into the view as a quote. Reported lines are source lines.
 */
export function resolveAnchorInView(
  view: TextSpace,
  source: TextSpace,
  input: AnchorInput,
): AnchorResolution {
  const direct = input.quote?.exact?.trim()
    ? resolveAnchor(view, { quote: input.quote, stale: input.stale })
    : null;
  if (direct && ((direct.status === "anchored" && !direct.ambiguous) || input.lineStart == null))
    return direct;
  const inSource = resolveAnchor(source, input);
  if (inSource.start == null || inSource.end == null) return direct ?? inSource;
  const carried = captureQuote(source.text, inSource.start, inSource.end);
  const inView = carried ? resolveAnchor(view, { quote: carried }) : null;
  if (inView?.start == null || inView.end == null) return direct ?? { status: "lost" };
  return {
    status: inSource.status === "anchored" && inView.status === "anchored" ? "anchored" : "moved",
    method: inSource.method,
    start: inView.start,
    end: inView.end,
    lineStart: inSource.lineStart,
    lineEnd: inSource.lineEnd,
  };
}

/**
 * Whether the version diff could still improve a resolution: anything but an
 * unambiguous, context-confirmed quote match.
 */
export function anchorNeedsDiff(r: AnchorResolution | undefined): boolean {
  return !(r && r.status === "anchored" && r.method === "quote" && !r.ambiguous);
}

/**
 * What to resolve for a comment, or null for a general (unanchored) comment.
 * `version` is set when the file changed since the comment was made.
 */
export function commentAnchorInput(
  c: {
    quote?: AnchorQuote;
    quotedContent?: string;
    lineStart?: number;
    lineEnd?: number;
    fileVersion?: number;
  },
  currentVersion: number | undefined,
): { version?: number; input: AnchorInput } | null {
  const quote = commentQuote(c);
  if (!quote && !c.lineStart) return null;
  const stale = c.fileVersion != null && currentVersion != null && c.fileVersion !== currentVersion;
  return {
    version: stale ? c.fileVersion : undefined,
    input: { quote, lineStart: c.lineStart, lineEnd: c.lineEnd, stale },
  };
}

// --- Spaces and capture -------------------------------------------------------

/** A TextSpace over plain source text (lines = the text's own lines). */
export function sourceTextSpace(text: string): TextSpace {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineCount = lineStarts.length;
  return {
    text,
    lineRangeToOffsets(a, b) {
      if (a > lineCount) return null;
      const s = Math.max(1, a);
      const e = Math.min(lineCount, Math.max(s, b));
      return [lineStarts[s - 1], e < lineCount ? lineStarts[e] - 1 : text.length];
    },
    offsetToLine(offset) {
      let lo = 0;
      let hi = lineCount - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) lo = mid;
        else hi = mid - 1;
      }
      return lo + 1;
    },
  };
}

/** Build the quote anchor for a selection [start, end) of `text`. */
export function captureQuote(text: string, start: number, end: number): AnchorQuote | undefined {
  // Trim the selection so the stored exact text matches what's highlighted.
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (start >= end) return undefined;
  return {
    exact: text.slice(start, Math.min(end, start + QUOTE_EXACT_MAX)),
    prefix: text.slice(Math.max(0, start - QUOTE_CONTEXT_CHARS), start) || undefined,
    suffix: text.slice(end, end + QUOTE_CONTEXT_CHARS) || undefined,
  };
}

/** The quote to resolve for a comment: the stored anchor, else legacy quotedContent. */
export function commentQuote(c: {
  quote?: AnchorQuote;
  quotedContent?: string;
}): AnchorQuote | undefined {
  if (c.quote?.exact) return c.quote;
  if (c.quotedContent?.trim()) return { exact: c.quotedContent };
  return undefined;
}
