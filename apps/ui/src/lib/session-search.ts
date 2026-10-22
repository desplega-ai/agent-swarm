// Sessions v2 sidebar search: the token parser and how the tokens become
// `GET /api/sessions` params (plan Phase 5, SPEC R6).
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { SessionStatusFilter, SessionTriageFilter } from "../api/types";

/** The `is:` values the search knows. */
export const SEARCH_IS = ["unread", "running", "needs", "later", "done"] as const;
export type SearchIs = (typeof SEARCH_IS)[number];

type TokenKind = "with" | "in" | "is";

export interface ParsedSearch {
  /** The free words, as typed. They go to `q`. */
  words: string[];
  /** `with:` values, lower case. */
  with: string[];
  /** `in:` values, lower case. */
  in: string[];
  is: SearchIs[];
  /** `is:` values the search does not know, as typed (`is:foo`). */
  bad: string[];
  /** A bare token that waits for its value (`with:` at the end). */
  partial: TokenKind | null;
  /** Nothing typed but spaces. */
  empty: boolean;
}

const TOKEN = /^(with|in|is):(.*)$/i;

/**
 * Split the search text into free words and `with:`, `in:`, and `is:`
 * tokens. A token's value may follow after a space (`with: lena`). A bare
 * token at the end waits for its value and filters nothing.
 */
export function parseSessionSearch(text: string): ParsedSearch {
  const parsed: ParsedSearch = {
    words: [],
    with: [],
    in: [],
    is: [],
    bad: [],
    partial: null,
    empty: text.trim() === "",
  };
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const match = TOKEN.exec(tokens[i]);
    if (!match) {
      parsed.words.push(tokens[i]);
      continue;
    }
    const kind = match[1].toLowerCase() as TokenKind;
    let value = match[2];
    const next = tokens[i + 1];
    if (!value && next && !TOKEN.test(next)) {
      value = next;
      i++;
    }
    if (!value) {
      parsed.partial = kind;
      continue;
    }
    const lower = value.toLowerCase();
    if (kind === "is") {
      if ((SEARCH_IS as readonly string[]).includes(lower)) parsed.is.push(lower as SearchIs);
      else parsed.bad.push(`is:${value}`);
    } else parsed[kind].push(lower);
  }
  return parsed;
}

/** A person the `with:` token can name. */
export interface SearchPerson {
  id: string;
  name: string;
}

/** A group the `in:` token can name, and that free words can match. */
export interface SearchGroup {
  key: string;
  /** The path as the sidebar shows it: `northwind › pricing`. */
  label: string;
}

/** The `GET /api/sessions` filters a search asks for (with `scope=tree`). */
export interface SessionSearchParams {
  q?: string;
  withUserId?: string;
  keyPrefix?: string;
  triage?: SessionTriageFilter;
  status?: SessionStatusFilter;
}

export type SessionSearchResult =
  | { ok: true; params: SessionSearchParams }
  /** The search cannot match anything as typed. `message` says why, in one sentence. */
  | { ok: false; message: string };

const PARTIAL_HINT: Record<TokenKind, string> = {
  with: "Type a name, like with:lena.",
  in: "Type a group, like in:pricing.",
  is: "Type unread, running, needs, later, or done.",
};

/** A person whose name (or one word of it) starts with `value`. A full-name match wins. */
function findPerson(value: string, people: SearchPerson[]): SearchPerson | null {
  const named = (person: SearchPerson) => person.name.toLowerCase();
  return (
    people.find((person) => named(person) === value) ??
    people.find((person) =>
      named(person)
        .split(/\s+/)
        .some((word) => word.startsWith(value)),
    ) ??
    people.find((person) => named(person).startsWith(value) || person.id.startsWith(value)) ??
    null
  );
}

/** The last segment of a group path, lower case. */
const lastName = (group: SearchGroup) => group.label.split(" › ").pop()?.trim().toLowerCase() ?? "";

/**
 * The group an `in:` value names: a group with that exact name first (the
 * shortest key, so `in:northwind` takes the parent), else the first path
 * that holds the value.
 */
function findGroup(value: string, groups: SearchGroup[]): SearchGroup | null {
  const exact = groups.filter((group) => lastName(group) === value);
  const pool =
    exact.length > 0 ? exact : groups.filter((g) => g.label.toLowerCase().includes(value));
  if (pool.length === 0) return null;
  return pool.reduce((best, group) => (group.key.length < best.key.length ? group : best));
}

/**
 * The list params for a parsed search. The server takes one person, one
 * group, and one read state, so a second one of a kind is refused with a
 * message instead of a silent guess.
 */
export function resolveSessionSearch(
  parsed: ParsedSearch,
  { people, groups }: { people: SearchPerson[]; groups: SearchGroup[] },
): SessionSearchResult {
  if (parsed.bad.length > 0) {
    return {
      ok: false,
      message: `${parsed.bad[0]} is not a filter. Try is:unread, is:running, is:needs, is:later, or is:done.`,
    };
  }
  const nothingElse =
    parsed.words.length + parsed.with.length + parsed.in.length + parsed.is.length === 0;
  if (parsed.partial && nothingElse) return { ok: false, message: PARTIAL_HINT[parsed.partial] };
  if (parsed.with.length > 1) return { ok: false, message: "Search for one person at a time." };
  if (parsed.in.length > 1) return { ok: false, message: "Search in one group at a time." };

  const params: SessionSearchParams = {};
  if (parsed.words.length > 0) params.q = parsed.words.join(" ");
  if (parsed.with[0]) {
    const person = findPerson(parsed.with[0], people);
    if (!person) return { ok: false, message: `No person matches with:${parsed.with[0]}.` };
    params.withUserId = person.id;
  }
  if (parsed.in[0]) {
    const group = findGroup(parsed.in[0], groups);
    if (!group) return { ok: false, message: `No group matches in:${parsed.in[0]}.` };
    params.keyPrefix = group.key;
  }
  const triage = [
    ...new Set(parsed.is.filter((value) => value !== "running" && value !== "needs")),
  ];
  if (triage.length > 1) {
    return { ok: false, message: "A session is in one of unread, later, or done. Pick one." };
  }
  if (triage[0]) params.triage = triage[0] as SessionTriageFilter;
  // The server takes one status: `is:needs` ("Needs you") or `is:running`.
  if (parsed.is.includes("running") && parsed.is.includes("needs")) {
    return { ok: false, message: "Search for running or needs, not both." };
  }
  if (parsed.is.includes("running")) params.status = "running";
  if (parsed.is.includes("needs")) params.status = "needs";
  return { ok: true, params };
}

/** Groups whose path holds every free word (SPEC R6: matching groups come after the sessions). */
export function matchingGroups(parsed: ParsedSearch, groups: SearchGroup[]): SearchGroup[] {
  if (parsed.words.length === 0) return [];
  const words = parsed.words.map((word) => word.toLowerCase());
  return groups.filter((group) => {
    const label = group.label.toLowerCase();
    return words.every((word) => label.includes(word));
  });
}

/**
 * The list params for the Cmd+K palette text: the same tokens as the
 * sidebar search, so `with:lena` finds Lena's sessions. Null when the text
 * is empty or cannot match (an unknown person, two groups).
 */
export function paletteSearchParams(
  text: string,
  lookups: { people: SearchPerson[]; groups: SearchGroup[] },
): SessionSearchParams | null {
  const parsed = parseSessionSearch(text);
  if (parsed.empty) return null;
  const result = resolveSessionSearch(parsed, lookups);
  return result.ok ? result.params : null;
}

/** A piece of a title, and whether a free word matched it. */
export interface TextPiece {
  text: string;
  match: boolean;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Cut `text` where any free word matches (case-insensitive), so a search
 * result can mark the match (SPEC R6). No words: one plain piece.
 */
export function splitMatches(text: string, words: readonly string[]): TextPiece[] {
  const terms = words.map((word) => word.trim()).filter(Boolean);
  if (terms.length === 0 || !text) return [{ text, match: false }];
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  // A split on one capture group puts each match at an odd index.
  return text
    .split(pattern)
    .map((piece, i) => ({ text: piece, match: i % 2 === 1 }))
    .filter((piece) => piece.text !== "");
}

/** The status bar filters (plan Phase 8): each one is an `is:` token in the sidebar search. */
export type QuickFilter = Extract<SearchIs, "running" | "needs" | "unread">;

/** Whether the sidebar search holds the quick filter's token. */
export function quickFilterOn(query: string, filter: QuickFilter): boolean {
  return parseSessionSearch(query).is.includes(filter);
}

/** The quick filters, so one replaces another (the status bar shows one at a time). */
const QUICK_FILTERS: readonly QuickFilter[] = ["running", "needs", "unread"];

/** A token that is exactly a quick filter (`is:unread`, any case). */
function quickTokenOf(token: string): QuickFilter | null {
  const match = /^is:(.+)$/i.exec(token);
  const value = match?.[1].toLowerCase();
  return QUICK_FILTERS.find((filter) => filter === value) ?? null;
}

/**
 * The search with a quick filter turned on or off. Only quick filter tokens
 * change: on drops the other quick filters and adds `is:<filter>` at the
 * end, off drops `is:<filter>`. Everything else stays as typed, in order.
 */
export function toggleQuickFilter(query: string, filter: QuickFilter): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const on = tokens.some((token) => quickTokenOf(token) === filter);
  const kept = tokens.filter((token) => quickTokenOf(token) === null);
  return (on ? kept : [...kept, `is:${filter}`]).join(" ");
}

/** A `with:` or `in:` token at the end of the search that waits for, or is getting, its value. */
export interface TypingToken {
  kind: "with" | "in";
  /** What follows the colon so far, lower case (may be empty). */
  value: string;
  /** Where the token starts in the text. */
  start: number;
}

const TYPING = /(^|\s)((with|in):\s?(\S*))$/i;

/**
 * The `with:` or `in:` token the user is typing at the end of the search
 * (`with:`, `with: le`, `in:pri`), so the phone can suggest its value. A
 * token that ends with a space is done.
 */
export function typingToken(text: string): TypingToken | null {
  const match = TYPING.exec(text);
  if (!match) return null;
  return {
    kind: match[3].toLowerCase() as TypingToken["kind"],
    value: match[4].toLowerCase(),
    start: match.index + match[1].length,
  };
}

/** The search with its typing token completed: `with:lena `, ready for the next word. */
export function completeToken(text: string, token: TypingToken, value: string): string {
  return `${text.slice(0, token.start)}${token.kind}:${value} `;
}

/** A suggestion for a typing token: the value it completes, and what the row shows. */
export interface TokenSuggestion {
  value: string;
  label: string;
  id: string;
}

/**
 * The people a `with:` value can name, as `resolveSessionSearch` reads them:
 * a name word that starts with the value. The token is the first name, or
 * the id's first 8 characters when two people share it.
 */
export function suggestPeople(value: string, people: SearchPerson[]): TokenSuggestion[] {
  const first = (person: SearchPerson) => person.name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const shared = (name: string) => people.filter((person) => first(person) === name).length > 1;
  return people
    .filter((person) =>
      person.name
        .toLowerCase()
        .split(/\s+/)
        .some((word) => word.startsWith(value)),
    )
    .map((person) => ({
      id: person.id,
      label: person.name,
      value: shared(first(person)) ? person.id.slice(0, 8) : first(person),
    }));
}

/**
 * The groups an `in:` value can name, as `resolveSessionSearch` reads them:
 * the path holds the value. The token is the group's last name.
 */
export function suggestGroups(value: string, groups: SearchGroup[]): TokenSuggestion[] {
  return groups
    .filter((group) => group.label.toLowerCase().includes(value))
    .map((group) => ({ id: group.key, label: group.label, value: lastName(group) }));
}
