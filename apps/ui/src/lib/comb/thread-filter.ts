// Comment search and filters for the comment rail. The same match decides
// the list and the passage highlights in the document.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { CommentEntry, CommentListEntry } from "../agent-fs/types";
import { commentQuote } from "./comment-anchor";
import type { ThreadSwarmState } from "./thread-status";

export type CommentFilter = "all" | "pending" | "processing" | "mentions" | "mine";

export const COMMENT_FILTERS: ReadonlyArray<{ value: CommentFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "mentions", label: "Mentions me" },
  { value: "mine", label: "Mine" },
];

export interface FilterFacts {
  /** The connected agent-fs user. Null: "Mentions me" and "Mine" match nothing. */
  me: string | null;
  /** Pending and processing threads (`threadSwarmStates`). */
  states: ReadonlyMap<string, ThreadSwarmState>;
}

/** A comment's author as the rail shows it (display name, member label, or "Swarm"). */
export type AuthorName = (entry: CommentEntry) => string;

/** The search text, trimmed and lower-cased. "" matches every thread. */
export function searchNeedle(query: string): string {
  return query.trim().toLocaleLowerCase();
}

/**
 * True when `needle` (`searchNeedle`) is in the thread's text, its quoted
 * passage, a reply's text, or the name of the thread's or a reply's author.
 * Case-insensitive.
 */
export function threadMatchesSearch(
  thread: CommentListEntry,
  needle: string,
  authorName: AuthorName,
): boolean {
  if (!needle) return true;
  const fields = [
    thread.body,
    commentQuote(thread)?.exact,
    authorName(thread),
    ...thread.replies.flatMap((reply) => [reply.body, authorName(reply)]),
  ];
  return fields.some((field) => field?.toLocaleLowerCase().includes(needle));
}

function mentions(entry: CommentEntry, userId: string): boolean {
  return entry.mentions?.some((mention) => mention.userId === userId) ?? false;
}

/**
 * True when the thread passes `filter`. "Mentions me": the thread or one of
 * its replies mentions the connected user. "Mine": the connected user wrote
 * the thread.
 */
export function threadMatchesFilter(
  thread: CommentListEntry,
  filter: CommentFilter,
  facts: FilterFacts,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "pending":
    case "processing":
      return facts.states.get(thread.id)?.kind === filter;
    case "mentions": {
      const { me } = facts;
      return me !== null && [thread, ...thread.replies].some((entry) => mentions(entry, me));
    }
    case "mine":
      return facts.me !== null && thread.author === facts.me;
  }
}

export interface ThreadQuery {
  /** `searchNeedle` of the search text. */
  needle: string;
  filter: CommentFilter;
}

/** True when the query shows every thread. */
export function isQueryEmpty(query: ThreadQuery): boolean {
  return query.needle === "" && query.filter === "all";
}

/** The threads that match both the search and the filter, in their order. */
export function filterThreads(
  threads: ReadonlyArray<CommentListEntry>,
  query: ThreadQuery,
  facts: FilterFacts,
  authorName: AuthorName,
): CommentListEntry[] {
  return threads.filter(
    (thread) =>
      threadMatchesFilter(thread, query.filter, facts) &&
      threadMatchesSearch(thread, query.needle, authorName),
  );
}

/** How many threads each filter shows, with the search applied. */
export function countByFilter(
  threads: ReadonlyArray<CommentListEntry>,
  needle: string,
  facts: FilterFacts,
  authorName: AuthorName,
): Record<CommentFilter, number> {
  const counts: Record<CommentFilter, number> = {
    all: 0,
    pending: 0,
    processing: 0,
    mentions: 0,
    mine: 0,
  };
  for (const thread of threads) {
    if (!threadMatchesSearch(thread, needle, authorName)) continue;
    for (const { value } of COMMENT_FILTERS) {
      if (threadMatchesFilter(thread, value, facts)) counts[value]++;
    }
  }
  return counts;
}
