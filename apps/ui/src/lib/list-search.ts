import type { AgentWithTasks } from "../api/types";

/**
 * Client-side list search, shared by a page's desktop grid and its phone rows
 * so the same query finds the same rows at every width.
 *
 * Mirrors AG Grid's quick filter semantics: the query splits on whitespace
 * and every term must appear somewhere in the row's searchable text.
 */
export function searchText(values: (string | number | null | undefined)[]): string {
  return values
    .filter((v) => v !== null && v !== undefined && v !== "")
    .join(" ")
    .toLowerCase();
}

export function matchesSearchTerms(text: string, query: string): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => text.includes(term));
}

/** Searchable text for an agents-list row. */
export function agentSearchText(
  agent: AgentWithTasks,
  /** Display-only values the list shows, such as the harness label or model. */
  extras: (string | null | undefined)[] = [],
): string {
  return searchText([agent.name, agent.role, agent.harnessProvider, agent.status, ...extras]);
}
