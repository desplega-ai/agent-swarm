/**
 * Adapter-side swarm lifecycle hooks for the Codex provider.
 *
 * Phase 5 (managed-agents) extracted the throttle/poll/heartbeat scaffolding
 * into `swarm-events-shared.ts`. This file is now a thin pass-through that
 * preserves the codex-specific public API (`createCodexSwarmEventHandler`,
 * `CodexSwarmEventHandlerOpts`) and adopts the shared implementation
 * verbatim — same throttle constants, same `fireAndForget` semantics, same
 * `try/catch` swallow-everything contract.
 *
 * ## Two-layer cancellation
 *
 * Layer 1 — runner-side polling: `src/commands/runner.ts:2812-2841` already
 * polls `GET /cancelled-tasks?taskId=...` on a timer and calls
 * `session.abort()` for any `ProviderSession`. Codex inherits this for free.
 *
 * Layer 2 — adapter-side (this file): on every `tool_start` we (throttled)
 * check the same endpoint and abort the running turn via the shared
 * `AbortController`. This *accelerates* cancellation latency but does NOT
 * block tool execution — Codex's SDK lacks a preToolUse blocking hook
 * (unlike pi-mono's `block: true` return value).
 */

import { createSwarmEventHandler, type SwarmEventHandlerOpts } from "./swarm-events-shared";
import type { ProviderEvent } from "./types";

/**
 * Codex-specific opts. Currently identical to the shared opts modulo the
 * `onCancel` field (which codex doesn't use today). Re-exported so existing
 * call sites (`codex-adapter.ts:303`) keep their import path stable.
 */
export type CodexSwarmEventHandlerOpts = Omit<
  SwarmEventHandlerOpts,
  "onCancel" | "sessionIdFallbackPrefix"
>;

/** Build the handler. The returned function reacts to normalized events. */
export function createCodexSwarmEventHandler(
  opts: CodexSwarmEventHandlerOpts,
): (event: ProviderEvent) => void {
  return createSwarmEventHandler({
    ...opts,
    sessionIdFallbackPrefix: "codex",
  });
}
