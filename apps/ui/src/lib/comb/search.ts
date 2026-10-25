// Comb search: one hit shape for the three agent-fs search ops. Pure, with
// relative imports only, so the root test runner covers it.
//
// - Name: `find` (fuzzy file names, agent-fs 0.18.5+).
// - Full text: `fts` (FTS5 over file text). The query is sent as literal terms.
// - Semantic: `search` (vectors and keywords, merged by rank).

import { AgentFsError } from "../agent-fs/client";
import type { FindResult, FtsResult, SearchResult } from "../agent-fs/types";
import { baseName, parentFolder } from "./paths";

export type SearchMode = "name" | "text" | "semantic";

/** The modes in the order the dialog lists them: file names, then meaning, then exact words. */
export const SEARCH_MODES: readonly SearchMode[] = ["name", "semantic", "text"];

/** The query params of an open search: `?q=<query>&mode=<file|semantic|text>`. */
export const SEARCH_QUERY_PARAM = "q";
export const SEARCH_MODE_PARAM = "mode";

const MODE_PARAMS: Record<SearchMode, string> = {
  name: "file",
  semantic: "semantic",
  text: "text",
};

/** The `mode` param of a search mode ("file" for name search). */
export function searchModeParam(mode: SearchMode): string {
  return MODE_PARAMS[mode];
}

/** The search mode of a `mode` param. Missing or unknown: file names. */
export function searchModeFromParam(value: string | null): SearchMode {
  return SEARCH_MODES.find((mode) => MODE_PARAMS[mode] === value) ?? "name";
}

/** The next mode in the dialog's order (`step` -1 goes back), wrapping around. Tab and Shift+Tab. */
export function nextSearchMode(mode: SearchMode, step: 1 | -1): SearchMode {
  const at = SEARCH_MODES.indexOf(mode);
  return SEARCH_MODES[(at + step + SEARCH_MODES.length) % SEARCH_MODES.length] as SearchMode;
}

/** The agent-fs op behind each mode. */
export const SEARCH_OPS: Record<SearchMode, "find" | "fts" | "search"> = {
  name: "find",
  text: "fts",
  semantic: "search",
};

/** A one-character name query matches most of the drive, so name search waits for two. */
export const MIN_NAME_QUERY_LENGTH = 2;
/** Most name matches one search lists. `total` still counts the rest. */
export const NAME_RESULT_LIMIT = 50;
/** Most semantic hits one search lists. */
export const SEMANTIC_RESULT_LIMIT = 20;

/** True when `query` is long enough to send for `mode`. */
export function isSearchable(mode: SearchMode, query: string): boolean {
  const trimmed = query.trim();
  return mode === "name" ? trimmed.length >= MIN_NAME_QUERY_LENGTH : trimmed.length > 0;
}

/**
 * FTS5 reads `"`, `*`, `-`, `:`, `AND`, `OR`, and `NEAR` as syntax. Each word
 * becomes a quoted phrase (inner quotes doubled), and the words are joined with
 * `AND`, so "a-b c" searches the text as typed and never fails to parse.
 */
export function literalFtsPattern(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

/**
 * The op params for one search. `scope` (a Comb folder, name search only)
 * limits `find` to the files below it.
 */
export function searchParams(
  mode: SearchMode,
  query: string,
  scope?: string,
): Record<string, unknown> {
  const trimmed = query.trim();
  switch (mode) {
    case "name":
      return scope && scope !== "/"
        ? { query: trimmed, limit: NAME_RESULT_LIMIT, path: scope }
        : { query: trimmed, limit: NAME_RESULT_LIMIT };
    case "text":
      return { pattern: literalFtsPattern(trimmed) };
    case "semantic":
      return { query: trimmed, limit: SEMANTIC_RESULT_LIMIT };
  }
}

/** One part of a snippet. `hit` marks the words that matched. */
export interface SnippetPart {
  text: string;
  hit: boolean;
}

/**
 * Split an FTS5 snippet into plain and matched parts. agent-fs marks matches
 * with `<b>` and `</b>`. Everything else is file text, so it stays text and is
 * never parsed as HTML. Runs of whitespace (newlines included) become one space.
 */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let hit = false;
  for (const piece of snippet.split(/(<b>|<\/b>)/)) {
    if (piece === "<b>") {
      hit = true;
    } else if (piece === "</b>") {
      hit = false;
    } else {
      const text = piece.replace(/\s+/g, " ");
      if (text) parts.push({ text, hit });
    }
  }
  if (parts[0]) parts[0].text = parts[0].text.trimStart();
  const last = parts[parts.length - 1];
  if (last) last.text = last.text.trimEnd();
  return parts.filter((part) => part.text !== "");
}

/** One result row, whatever the mode. */
export interface SearchHit {
  /** Comb drive path ("/docs/a.md"). */
  path: string;
  name: string;
  /** The folder that holds the file ("/docs/"). */
  folder: string;
  snippet: SnippetPart[];
  /** "Page 3" (a PDF chunk), "Image", or null. */
  chip: string | null;
  /** Name search only: the file's size and last change. */
  size?: number;
  modifiedAt?: string;
}

/** What a search answered, mapped for the list. */
export interface SearchOutcome {
  hits: SearchHit[];
  /** Matches on the server, above `hits.length` when the list is capped (name search). */
  total: number;
  /** A server hint, for example "keyword results only" without embeddings. */
  hint: string | null;
}

/** agent-fs answers "/docs/a.md" or "docs/a.md". Comb paths start with "/". */
function combDrivePath(path: string): string {
  return `/${path.replace(/^\/+/, "")}`;
}

function hitFor(path: string, snippet: string | undefined, chip: string | null): SearchHit {
  const combPath = combDrivePath(path);
  return {
    path: combPath,
    name: baseName(combPath),
    folder: parentFolder(combPath),
    snippet: snippet ? snippetParts(snippet) : [],
    chip,
  };
}

/** The chip of a semantic hit: only PDF chunks carry a page, and an image hit names its kind. */
function semanticChip(item: { page?: number; kind?: string }): string | null {
  if (item.page != null) return `Page ${item.page}`;
  if (item.kind === "image") return "Image";
  return null;
}

/** Map one op answer to the list's hits. A path that comes back twice is listed once. */
export function searchOutcome(
  mode: SearchMode,
  result: FindResult | FtsResult | SearchResult,
): SearchOutcome {
  let hits: SearchHit[];
  // Only `find` caps its list and reports the full count.
  let serverTotal = 0;
  let hint: string | null = null;
  if (mode === "name") {
    const found = result as FindResult;
    hits = found.matches.map((match) => ({
      ...hitFor(match.path, undefined, null),
      size: match.size,
      modifiedAt: match.modifiedAt,
    }));
    serverTotal = found.total;
  } else if (mode === "text") {
    const found = result as FtsResult;
    hits = found.matches.map((match) => hitFor(match.path, match.snippet, null));
    // The FTS hint repeats the query and points at the CLI. Comb names the mode instead.
    if (hits.length === 0 && found.hint) hint = "Full text matches exact words. Try Semantic.";
  } else {
    const found = result as SearchResult;
    hits = found.results.map((item) =>
      // An image hit's snippet is a marker such as "[image]". The chip says the same.
      hitFor(item.path, item.kind === "image" ? undefined : item.snippet, semanticChip(item)),
    );
    hint = found.hint ?? null;
  }
  const byPath = new Map<string, SearchHit>();
  for (const hit of hits) if (!byPath.has(hit.path)) byPath.set(hit.path, hit);
  hits = [...byPath.values()];
  return { hits, total: Math.max(serverTotal, hits.length), hint };
}

/**
 * True when agent-fs does not know `op` (a server older than the op). agent-fs
 * answers 500 `INTERNAL_ERROR` with "Unknown operation: <op>".
 */
export function isUnknownOpError(error: unknown, op: string): boolean {
  return (
    error instanceof AgentFsError &&
    error.message.toLowerCase().startsWith(`unknown operation: ${op.toLowerCase()}`)
  );
}
