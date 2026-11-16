import { githubAdapter } from "./github";
import type { ExternalEventAdapter } from "./types";

export * from "./types";

/** Register a provider here: this is the only list to extend (GitLab, Linear, ...). */
export const EXTERNAL_EVENT_ADAPTERS: readonly ExternalEventAdapter[] = [githubAdapter];

export function getExternalEventAdapter(source: string): ExternalEventAdapter | undefined {
  return EXTERNAL_EVENT_ADAPTERS.find((adapter) => adapter.source === source);
}

/**
 * Bus names the webhook ingest owns. The workflow-events API emits caller-chosen names on the
 * same bus, so it must refuse these: a forged provider event could wake an adapter that
 * trusts the event (no `confirm`), or drive confirm reads with server credentials.
 */
export function isReservedProviderEvent(name: string): boolean {
  return EXTERNAL_EVENT_ADAPTERS.some((adapter) => name.startsWith(adapter.busPrefix));
}

/** Every shared event name some adapter serves, deduplicated. */
export const EXTERNAL_EVENT_NAMES: [string, ...string[]] = [
  ...new Set(EXTERNAL_EVENT_ADAPTERS.flatMap((adapter) => adapter.events)),
] as [string, ...string[]];

/** Tool-description line listing the served events; the docs generator reads it as a literal, so keep it in step with the list above. */
export const EXTERNAL_EVENTS_DOC =
  'vcs.pr.merged with source "github" and match {repo (owner/name), number}';
