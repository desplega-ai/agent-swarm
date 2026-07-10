/**
 * Slack-routing coherence guard.
 *
 * A task's Slack destination is carried by three fields — `slackChannelId`,
 * `slackThreadTs`, `slackUserId` — which delivery code (`src/slack/responses.ts`,
 * `src/slack/watcher.ts`, `src/tools/slack-reply.ts`) reads directly, alongside
 * the durable, immutable `contextKey` that records where a task's ingress
 * entity actually lives. Nothing upstream compared the two before creating a
 * task, so a caller could hand-type a `slackChannelId` that disagreed with
 * both the parent task and the inherited `contextKey`, silently misrouting a
 * worker's completion summary into the wrong human's DM (see swarm memory
 * `dispatch-slack-channel-must-match-parent-context-2026-07-10`).
 *
 * This module is pure and dependency-light (only the `AgentTask` type +
 * `parseContextKey`) so it can be imported from both the agent-facing tool
 * boundary (`src/tools/send-task.ts`, strict-reject) and the DB boundary
 * (`src/be/db.ts` `createTaskExtended`, normalize-and-warn).
 */

import type { AgentTask } from "../types";
import { parseContextKey } from "./context-key";

export type SlackUnit = {
  channelId?: string | null;
  threadTs?: string | null;
  userId?: string | null;
};

export type SlackRoutingVerdict =
  | { verdict: "ok" }
  | { verdict: "partial-unit"; detail: string }
  | {
      verdict: "mismatch";
      field: "slackChannelId" | "slackThreadTs";
      expected: string;
      expectedSource: "parent" | "contextKey";
      got: string;
      detail: string;
    };

/**
 * Parse the Slack channel/thread encoded in a `contextKey`, iff it is
 * slack-family. Returns `null` for non-slack families and for malformed keys
 * — a parse failure here must never throw, since this runs on hot creation
 * paths that also handle non-Slack ingress.
 */
export function slackChannelFromContextKey(
  key: string | null | undefined,
): { channelId: string; threadTs: string } | null {
  if (!key) return null;
  try {
    const parsed = parseContextKey(key);
    if (parsed.family !== "slack") return null;
    return { channelId: parsed.parts.channelId, threadTs: parsed.parts.threadTs };
  } catch {
    return null;
  }
}

/**
 * Check whether an explicit Slack unit is coherent with the parent task and
 * the contextKey the new task will carry. `channelId`/`threadTs` must be
 * both-or-neither (delivery requires both); when a channel is present it
 * must agree with the parent's `slackChannelId` (if set) and with the
 * channel/thread encoded in a slack-family `inheritedContextKey` (if any).
 * `userId` is attribution only and is never checked — it is harmless on its
 * own.
 */
export function checkSlackRoutingCoherence(input: {
  explicit: SlackUnit;
  parent?: Pick<AgentTask, "slackChannelId" | "slackThreadTs" | "contextKey"> | null;
  inheritedContextKey?: string | null;
}): SlackRoutingVerdict {
  const { explicit, parent, inheritedContextKey } = input;
  const hasChannel = !!explicit.channelId;
  const hasThread = !!explicit.threadTs;

  if (hasChannel !== hasThread) {
    return {
      verdict: "partial-unit",
      detail: hasChannel
        ? `slackChannelId "${explicit.channelId}" was passed without slackThreadTs — both are required together for Slack delivery to work.`
        : `slackThreadTs "${explicit.threadTs}" was passed without slackChannelId — both are required together for Slack delivery to work.`,
    };
  }

  if (!hasChannel) {
    return { verdict: "ok" };
  }

  const channelId = explicit.channelId as string;
  const threadTs = explicit.threadTs as string;

  if (parent?.slackChannelId && channelId !== parent.slackChannelId) {
    return {
      verdict: "mismatch",
      field: "slackChannelId",
      expected: parent.slackChannelId,
      expectedSource: "parent",
      got: channelId,
      detail: `explicit slackChannelId "${channelId}" does not match the parent task's slackChannelId "${parent.slackChannelId}".`,
    };
  }

  const contextKeySlack = slackChannelFromContextKey(inheritedContextKey);
  if (contextKeySlack) {
    if (channelId !== contextKeySlack.channelId) {
      return {
        verdict: "mismatch",
        field: "slackChannelId",
        expected: contextKeySlack.channelId,
        expectedSource: "contextKey",
        got: channelId,
        detail: `explicit slackChannelId "${channelId}" does not match the channel encoded in contextKey "${inheritedContextKey}" ("${contextKeySlack.channelId}").`,
      };
    }
    if (threadTs !== contextKeySlack.threadTs) {
      return {
        verdict: "mismatch",
        field: "slackThreadTs",
        expected: contextKeySlack.threadTs,
        expectedSource: "contextKey",
        got: threadTs,
        detail: `explicit slackThreadTs "${threadTs}" does not match the thread encoded in contextKey "${inheritedContextKey}" ("${contextKeySlack.threadTs}").`,
      };
    }
  }

  return { verdict: "ok" };
}
