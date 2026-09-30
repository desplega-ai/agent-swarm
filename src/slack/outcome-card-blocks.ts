import { isEnvFlagEnabled } from "../utils/env-flag";
import { getTaskUrl } from "./blocks";

/**
 * Action blocks for the v2 outcome card: 👍/👎 feedback plus Follow up and
 * Open task on an answer, Retry plus Follow up and Open task on a failure.
 * When interactivity is off, or Slack rejects these blocks, the card falls
 * back to plain footer links (`fallbackFooterParts`).
 */

export const OUTCOME_FEEDBACK_ACTION_ID = "outcome_feedback";
export const OUTCOME_FEEDBACK_REASON_CALLBACK_ID = "outcome_feedback_reason";
export const RETRY_TASK_ACTION_ID = "retry_task";
// Existing handlers in actions.ts: the follow-up modal, and the URL button ack.
export const FOLLOW_UP_ACTION_ID = "follow_up_task";
export const OPEN_TASK_ACTION_ID = "view_task_logs";

export type OutcomeActionKind = "answer" | "failure";
export type OutcomeRating = "up" | "down";
export type FailureClass = "transient" | "cant_do";

export function isSlackOutcomeActionsEnabled(): boolean {
  return isEnvFlagEnabled("SLACK_OUTCOME_ACTIONS", true);
}

function button(text: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: "button", text: { type: "plain_text", text }, ...fields };
}

export function outcomeActionBlocks(taskId: string, kind: OutcomeActionKind): unknown[] {
  const followUp = button("Follow up", { action_id: FOLLOW_UP_ACTION_ID, value: taskId });
  const openTask = button("Open task", { action_id: OPEN_TASK_ACTION_ID, url: getTaskUrl(taskId) });
  if (kind === "failure") {
    const retry = button("Retry", {
      action_id: RETRY_TASK_ACTION_ID,
      value: taskId,
      style: "primary",
    });
    return [
      { type: "actions", block_id: "outcome_actions", elements: [retry, followUp, openTask] },
    ];
  }
  return [
    {
      type: "context_actions",
      block_id: "outcome_feedback",
      elements: [
        {
          type: "feedback_buttons",
          action_id: OUTCOME_FEEDBACK_ACTION_ID,
          positive_button: {
            text: { type: "plain_text", text: "Good response" },
            accessibility_label: "Rate this answer as helpful",
            value: `up:${taskId}`,
          },
          negative_button: {
            text: { type: "plain_text", text: "Bad response" },
            accessibility_label: "Rate this answer as not helpful",
            value: `down:${taskId}`,
          },
        },
      ],
    },
    { type: "actions", block_id: "outcome_actions", elements: [followUp, openTask] },
  ];
}

/** Footer additions for a card that carries no interactive blocks. */
export function fallbackFooterParts(taskId: string, kind: OutcomeActionKind): string[] {
  const link = `<${getTaskUrl(taskId)}|Retry or follow up>`;
  return kind === "answer" ? [link, "react :+1: / :-1: to rate"] : [link];
}

export function parseFeedbackValue(
  value: string | undefined,
): { rating: OutcomeRating; taskId: string } | undefined {
  const match = value?.match(/^(up|down):(.+)$/);
  if (!match?.[1] || !match[2]) return undefined;
  return { rating: match[1] as OutcomeRating, taskId: match[2] };
}

// Checked first: a limit the swarm cannot get past by trying again.
const CANT_DO_PATTERN =
  /permission|forbidden|\b403\b|unauthori[sz]ed|not (?:allowed|permitted)|access denied|lead[- ]only|requires? (?:a |the )?lead|\blane\b|out of scope|missing scope/i;
// A run that died on the way, where the same ask can succeed on a second try.
const TRANSIENT_PATTERN =
  /crash|time[sd]? ?out|timeout|stall|heartbeat|killed|\boom\b|out of memory|restart|reboot|shut ?down|sigterm|sigkill|econn|network|rate.?limit|\b429\b|internal server error|bad gateway|overloaded|unavailable|worker (?:died|lost|offline)|session (?:ended|expired|lost)/i;

export function classifyFailure(reason: string | null | undefined): FailureClass | undefined {
  if (!reason?.trim()) return undefined;
  if (CANT_DO_PATTERN.test(reason)) return "cant_do";
  if (TRANSIENT_PATTERN.test(reason)) return "transient";
  return undefined;
}

export function failureHint(failureClass: FailureClass | undefined): string | undefined {
  if (failureClass === "transient") {
    return "_This looks transient (a crash or timeout), so a retry should work._";
  }
  if (failureClass === "cant_do") {
    return "_I can't do this as set up (a permission or lane limit), so a plain retry won't help. Follow up with what to change._";
  }
  return undefined;
}

/**
 * Send `interactive` blocks; when Slack answers `invalid_blocks` (a workspace
 * or client that does not accept the action blocks), send `fallback` once
 * instead of dropping the card.
 */
export async function sendWithBlocksFallback<T>(
  interactive: unknown[],
  fallback: unknown[],
  send: (blocks: unknown[]) => Promise<T>,
  label: string,
): Promise<T> {
  if (interactive === fallback) return await send(fallback);
  try {
    return await send(interactive);
  } catch (error) {
    if ((error as { data?: { error?: string } })?.data?.error !== "invalid_blocks") throw error;
    console.warn(`[Slack] ${label} rejected the outcome action blocks; retrying without them`);
    return await send(fallback);
  }
}
