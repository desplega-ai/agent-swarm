/**
 * Which approval requests a chat button can answer, and the answer a button
 * maps to. Chat cards (Slack, Chat SDK) share this so every channel offers the
 * same choices and stores the same response the dashboard would.
 */

/** Chat SDK transports that can post and update an approval card. */
export function isChatApprovalChannel(channel: string | undefined): boolean {
  return channel === "telegram" || channel === "discord" || channel === "teams";
}

export interface ApprovalQuestionLike {
  id?: string;
  type?: string;
  label?: string;
  multiline?: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
}

export interface InlineApprovalQuestion {
  id: string;
  type: "approval" | "boolean" | "single-select" | "text";
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
}

/** Single-select questions with more options than this go to the dashboard. */
export const INLINE_MAX_OPTIONS = 5;

/** Longest one-line text answer a chat modal accepts. */
export const INLINE_TEXT_MAX_LENGTH = 500;

/**
 * The one question a chat button can answer, or null when the request needs
 * the dashboard: several questions, multi-select, config, multiline text, or a
 * single-select with no options or more than `INLINE_MAX_OPTIONS`.
 */
export function inlineApprovalQuestion(
  questions: ReadonlyArray<ApprovalQuestionLike> | null | undefined,
): InlineApprovalQuestion | null {
  // shortcut: one question per inline card; several simple questions could share one Slack modal later.
  if (!questions || questions.length !== 1) return null;
  const [q] = questions;
  if (!q?.id) return null;
  const base = { id: q.id, label: q.label ?? "", options: q.options ?? [] };
  switch (q.type) {
    case "approval":
    case "boolean":
      return { ...base, type: q.type };
    case "single-select":
      return base.options.length > 0 && base.options.length <= INLINE_MAX_OPTIONS
        ? { ...base, type: q.type }
        : null;
    case "text":
      return q.multiline ? null : { ...base, type: q.type };
    default:
      return null;
  }
}

/**
 * A button's choice: `y` / `n` for approval and boolean questions, the option
 * index for single-select, `t` for text. Short on purpose: Telegram callback
 * data is capped at 64 bytes.
 */
export interface InlineChoice {
  /** Label and style of the button. */
  label: string;
  choice: string;
  style?: "primary" | "danger";
  /** The button collects text first (Deny reason, text answer) where the channel has modals. */
  needsText?: "optional" | "required";
}

export function inlineApprovalChoices(question: InlineApprovalQuestion): InlineChoice[] {
  switch (question.type) {
    case "approval":
      return [
        { label: "Approve", choice: "y", style: "primary" },
        { label: "Deny", choice: "n", style: "danger", needsText: "optional" },
      ];
    case "boolean":
      return [
        { label: "Yes", choice: "y" },
        { label: "No", choice: "n" },
      ];
    case "single-select":
      return question.options.map((option, index) => ({
        label: option.label || option.value,
        choice: String(index),
      }));
    case "text":
      return [{ label: "Answer", choice: "t", needsText: "required" }];
  }
}

/**
 * The respond-route `responses` for a choice, or null for a choice this
 * question does not offer (a forged or stale button).
 */
export function inlineApprovalResponses(
  question: InlineApprovalQuestion,
  choice: string,
  text?: string,
): Record<string, unknown> | null {
  const trimmed = (text ?? "").trim().slice(0, INLINE_TEXT_MAX_LENGTH);
  let answer: unknown;
  switch (question.type) {
    case "approval":
      if (choice === "y") answer = { approved: true };
      else if (choice === "n")
        answer = trimmed ? { approved: false, comment: trimmed } : { approved: false };
      break;
    case "boolean":
      if (choice === "y" || choice === "n") answer = choice === "y";
      break;
    case "single-select": {
      const option = /^\d+$/.test(choice) ? question.options[Number(choice)] : undefined;
      answer = option?.value;
      break;
    }
    case "text":
      if (choice === "t" && trimmed) answer = trimmed;
      break;
  }
  return answer === undefined ? null : { [question.id]: answer };
}
