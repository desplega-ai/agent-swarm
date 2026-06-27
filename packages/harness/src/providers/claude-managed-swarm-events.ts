/**
 * Adapter-side swarm lifecycle hooks for the Claude Managed Agents provider.
 *
 * Phase 5 of the managed-agents rollout. Mirrors `codex-swarm-events.ts`:
 * thin wrapper around `swarm-events-shared.ts` that wires the shared
 * throttle/poll/heartbeat scaffolding to the managed-agents cancel pathway.
 *
 * ## Cancel callback semantics
 *
 * When the shared `checkCancelled` poll detects a cancellation, it (1) fires
 * `abortRef.current?.abort()` and (2) invokes our `onCancel` callback. The
 * callback issues `client.beta.sessions.events.send(sessionId, { events:
 * [{ type: "user.interrupt" }] })` followed by
 * `client.beta.sessions.archive(sessionId)`.
 *
 * Both calls are best-effort and `.catch()`-ed: an already-archived or
 * already-terminated session returns errors that we don't want to leak into
 * the event handler (which is supposed to be synchronous and never throw).
 *
 * The adapter's own `abort()` method does the same dance directly — this
 * binding exists so EXTERNAL cancel polls (i.e. another worker process or
 * the runner-side polling layer) can drive the same flow without going
 * through `session.abort()`.
 */

import { createSwarmEventHandler, type SwarmEventHandlerOpts } from "./swarm-events-shared";
import type { ProviderEvent } from "./types";

/**
 * Minimal slice of the managed-agents client surface we need to issue
 * `user.interrupt` + archive. Kept as a structural type so this file doesn't
 * have to import the full `ManagedAgentsClient` (and so unit tests can
 * pass in a tiny stub).
 */
export interface ClaudeManagedCancelClient {
  beta: {
    sessions: {
      archive: (sessionId: string) => unknown;
      events: {
        send: (sessionId: string, params: { events: Array<Record<string, unknown>> }) => unknown;
      };
    };
  };
}

export interface ClaudeManagedSwarmEventHandlerOpts
  extends Omit<SwarmEventHandlerOpts, "onCancel" | "sessionIdFallbackPrefix"> {
  /** The Anthropic SDK client; used to send interrupt + archive on cancel. */
  client: ClaudeManagedCancelClient;
  /** The managed session currently in flight. */
  managedSessionId: string;
}

/**
 * Build a swarm-event handler that drives managed-agents cancel actions on
 * top of the shared throttle/poll/heartbeat scaffolding.
 */
export function createClaudeManagedSwarmEventHandler(
  opts: ClaudeManagedSwarmEventHandlerOpts,
): (event: ProviderEvent) => void {
  const { client, managedSessionId, ...shared } = opts;

  return createSwarmEventHandler({
    ...shared,
    sessionIdFallbackPrefix: "claude-managed",
    onCancel: () => {
      // Fire-and-forget interrupt; swallow errors (already-archived sessions
      // raise here and we don't want to leak that into the handler).
      void Promise.resolve(
        client.beta.sessions.events.send(managedSessionId, {
          events: [{ type: "user.interrupt" }],
        }),
      ).catch(() => {});
      void Promise.resolve(client.beta.sessions.archive(managedSessionId)).catch(() => {});
    },
  });
}
