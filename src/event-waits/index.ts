import { githubAdapter } from "./github";
import type { ExternalEventAdapter } from "./types";

export * from "./types";

/** Register a provider here: this is the only list to extend (GitLab, Linear, ...). */
export const EXTERNAL_EVENT_ADAPTERS: readonly ExternalEventAdapter[] = [githubAdapter];

export function getExternalEventAdapter(source: string): ExternalEventAdapter | undefined {
  return EXTERNAL_EVENT_ADAPTERS.find((adapter) => adapter.source === source);
}

/** Every shared event name some adapter serves, deduplicated. */
export const EXTERNAL_EVENT_NAMES: [string, ...string[]] = [
  ...new Set(EXTERNAL_EVENT_ADAPTERS.flatMap((adapter) => adapter.events)),
] as [string, ...string[]];

/** Tool-description line listing the served events; the docs generator reads it as a literal, so keep it in step with the list above. */
export const EXTERNAL_EVENTS_DOC =
  'vcs.pr.merged with source "github" and match {repo (owner/name), number}';
