/**
 * External-event waits: `defer-task wakeOn {event, source, match}` wakes an agent
 * when a provider event arrives. Events enter through the webhook ingest that
 * already emits on `workflowEventBus` (src/http/webhooks.ts); a provider plugs in
 * by implementing this interface and registering in ./index.ts. The scheduler,
 * the tool schema and the table know nothing about any one provider.
 */

/** What a wait targets, normalized by the adapter (e.g. `{repo: "owner/name", number: 7}`). */
export type EventMatch = Record<string, string | number>;

/** A provider event reduced to the shared vocabulary (e.g. `vcs.pr.merged`). */
export type ExternalEvent = { event: string; match: EventMatch };

export interface ExternalEventAdapter {
  /** Provider id as agents write it in `wakeOn.source`, e.g. `github`. */
  readonly source: string;
  /** Shared event names this adapter can serve, e.g. `vcs.pr.merged`. */
  readonly events: readonly string[];
  /** What `match` holds, for the tool description, e.g. `repo (owner/name), number`. */
  readonly matchHint: string;
  /** `workflowEventBus` name prefix the provider's webhook handler emits under, e.g. `github.`. */
  readonly busPrefix: string;
  /** True when `confirm` reads with server-held credentials, so task-scoped tokens may not trigger it. */
  readonly readsWithServerCredentials?: boolean;
  /** False when the provider integration is off, so no event could ever arrive. */
  isEnabled(): boolean;
  /** Validate and normalize the agent's match for `event`; throw an Error whose message names the fix. */
  parseMatch(event: string, match: unknown): EventMatch;
  /** Map one bus event to the shared events it signals (usually zero or one). Must not throw. */
  fromBusEvent(busEvent: string, payload: unknown): ExternalEvent[];
  /**
   * Optional authoritative read: has `event` already happened for `match`? Throws
   * when the provider cannot be read. With it, a webhook only names a candidate and
   * the wait fires only on `true`, and boot re-checks pending waits (a delivery
   * missed while the API was down). Without it, the verified webhook is trusted.
   */
  confirm?(event: string, match: EventMatch): Promise<boolean>;
}

/** Canonical key for lookup: the same match always yields the same string. */
export function matchKeyOf(match: EventMatch): string {
  return JSON.stringify(Object.entries(match).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function describeEventWait(source: string, event: string, match: EventMatch): string {
  const target = Object.entries(match)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
  return `${event} on ${source} (${target})`;
}
