import { inlineApprovalChoices, inlineApprovalQuestion } from "../workflows/approval-inline";

/** Button `action_id` prefix; the rest is the `InlineChoice.choice`, the value the request id. */
export const APPROVAL_ACTION_PREFIX = "hitl_answer:";

/** Slack caps button text at 75 characters. */
function buttonText(label: string): string {
  return label.length > 75 ? `${label.slice(0, 74)}…` : label;
}

/**
 * The inline answer buttons for a pending approval card, or none when the
 * request needs the dashboard (see `inlineApprovalQuestion`).
 */
export function buildApprovalAnswerButtons(
  requestId: string,
  questions: Parameters<typeof inlineApprovalQuestion>[0],
): Record<string, unknown>[] {
  const question = inlineApprovalQuestion(questions);
  if (!question) return [];
  return inlineApprovalChoices(question).map((choice) => ({
    type: "button",
    action_id: `${APPROVAL_ACTION_PREFIX}${choice.choice}`,
    text: { type: "plain_text", text: buttonText(choice.label) },
    value: requestId,
    ...(choice.style ? { style: choice.style } : {}),
  }));
}
