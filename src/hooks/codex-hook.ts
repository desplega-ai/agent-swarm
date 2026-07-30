#!/usr/bin/env bun

/**
 * Codex lifecycle hook — harness-side steering delivery.
 *
 * Codex has no in-process steering channel: `@openai/codex-sdk` drives
 * `codex exec` with stdin written once and closed, and the app-server's
 * native `turn/steer` is not reachable through the SDK (issue #1034). So
 * delivery happens here instead: this hook runs inside the codex lifecycle
 * (registered for SessionStart / PostToolUse / Stop via the managed
 * `/etc/codex/requirements.toml` in the worker image), polls the API for
 * pending steering rows, marks them `delivered`, and injects the rendered
 * envelope into the model's context:
 *
 *   - SessionStart / PostToolUse → `hookSpecificOutput.additionalContext`
 *     (verified to reach the model at codex-cli 0.146.0; PreToolUse drops
 *     additionalContext upstream, so it is deliberately not registered).
 *   - Stop → `{"decision":"block","reason":...}` so a session about to end
 *     still receives the message and continues to act on it.
 *
 * One-shot guarantee: a message is included in hook output only after its
 * `/delivered` POST succeeded, so a message is injected at most once. A
 * failed POST leaves the row `pending` for the next lifecycle event; rows a
 * dying session never picks up are promoted by the server's terminal sweep.
 * The runner's dispatch poll skips codex sessions entirely
 * (`ProviderSession.steeringDeliveredExternally`).
 */

import { renderSteeringDelivery } from "../prompts/steering-delivery.ts";
import type { SteeringMessage } from "../types";
import { getApiKey } from "../utils/api-key";
import { getMcpBaseUrl } from "../utils/constants";
import { isSteeringEnabled } from "../utils/steering-enabled";

const FETCH_TIMEOUT_MS = 5_000;

export interface CodexHookMessage {
  hook_event_name?: string;
  stop_hook_active?: boolean;
}

export interface CodexHookConfig {
  apiUrl: string;
  apiKey: string;
  agentId: string;
}

export function resolveCodexHookConfig(
  env: Record<string, string | undefined> = process.env,
): CodexHookConfig | null {
  const agentId = env.AGENT_ID;
  const apiKey = getApiKey(env);
  const apiUrl = getMcpBaseUrl();
  if (!agentId || !apiKey || !apiUrl) return null;
  return { apiUrl, apiKey, agentId };
}

/**
 * Fetch the agent's pending steering rows, mark each `delivered`, and return
 * the rendered envelopes of the ones whose delivered-POST succeeded.
 *
 * Any error yields an empty result — a hook must never take the harness down
 * over steering, and `pending` rows are retried on the next lifecycle event.
 */
export async function collectDeliverableSteering(
  config: CodexHookConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    "X-Agent-ID": config.agentId,
  };

  let messages: SteeringMessage[];
  try {
    const response = await fetchImpl(`${config.apiUrl}/api/steering-messages`, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { messages?: SteeringMessage[] };
    messages = (data.messages ?? []).filter((message) => message.status === "pending");
  } catch {
    return [];
  }

  const delivered: string[] = [];
  for (const message of messages) {
    // Mark delivered BEFORE injecting: if the POST fails the row stays
    // pending and is retried later; the inverse order could inject the same
    // message on every tool call ("no polluting").
    try {
      const report = await fetchImpl(
        `${config.apiUrl}/api/steering-messages/${encodeURIComponent(message.id)}/delivered`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "queue" }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      );
      if (!report.ok) continue;
    } catch {
      continue;
    }
    delivered.push(await renderSteeringDelivery(message.id, message.body));
  }
  return delivered;
}

/**
 * Handle one codex hook event. Returns the JSON object to print to stdout
 * (codex reads hook responses from stdout), or null for no output.
 */
export async function handleCodexHookEvent(
  msg: CodexHookMessage,
  config: CodexHookConfig | null,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown> | null> {
  const event = msg.hook_event_name;
  if (!event || !config || !isSteeringEnabled(env)) return null;
  if (event !== "SessionStart" && event !== "PostToolUse" && event !== "Stop") return null;

  const envelopes = await collectDeliverableSteering(config, fetchImpl);
  if (envelopes.length === 0) return null;
  const additionalContext = envelopes.join("\n\n");

  if (event === "Stop") {
    // Delivered rows are marked before this block fires, so the next Stop
    // finds nothing pending and lets the session end — no block loop.
    return {
      decision: "block",
      reason: `Steering message(s) arrived before you finished:\n\n${additionalContext}`,
    };
  }

  return {
    hookSpecificOutput: { hookEventName: event, additionalContext },
  };
}

/** stdin/stdout entry point used by the `codex-hook` CLI command. */
export async function handleCodexHook(): Promise<void> {
  let msg: CodexHookMessage;
  try {
    msg = (await Bun.stdin.json()) as CodexHookMessage;
  } catch {
    return;
  }
  try {
    const output = await handleCodexHookEvent(msg, resolveCodexHookConfig());
    if (output) console.log(JSON.stringify(output));
  } catch {
    // Never fail the harness over steering delivery.
  }
}
