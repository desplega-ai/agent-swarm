import {
  type ActionEvent,
  Actions,
  Button,
  type ButtonElement,
  Card,
  type CardElement,
  CardText,
  type Chat,
  LinkButton,
} from "chat";
import { answerApprovalFromChat } from "@/http/approval-chat-answer";
import {
  type ApprovalQuestionLike,
  inlineApprovalChoices,
  inlineApprovalQuestion,
} from "@/workflows/approval-inline";
import { trackBackground } from "./background";
import { errorMessage } from "./logger";

/**
 * Button id prefix; the rest is the `InlineChoice.choice`, the value the
 * request id. Telegram callback data is 64 bytes: `ha:<choice>` plus a UUID fits.
 */
export const CHAT_APPROVAL_ACTION_PREFIX = "ha:";

/**
 * The pending approval card. A simple request gets answer buttons; choices
 * that need typed text (a text answer) stay on the dashboard, since Telegram
 * has no modals. Deny on Telegram rejects without a reason.
 */
export function buildChatApprovalCard(input: {
  requestId: string;
  title: string;
  questions: ReadonlyArray<ApprovalQuestionLike>;
  approvalUrl: string;
  timeoutText?: string;
}): CardElement {
  const question = inlineApprovalQuestion(input.questions);
  const buttons: ButtonElement[] = question
    ? inlineApprovalChoices(question)
        .filter((choice) => choice.needsText !== "required")
        .map((choice) =>
          Button({
            id: `${CHAT_APPROVAL_ACTION_PREFIX}${choice.choice}`,
            label: choice.label,
            value: input.requestId,
            ...(choice.style ? { style: choice.style } : {}),
          }),
        )
    : [];
  const lines = input.questions.map((q) => `• ${(q.label ?? "").replace(/\s+/g, " ").trim()}`);
  return Card({
    title: `Approval required: ${input.title}`,
    children: [
      CardText([...lines, ...(input.timeoutText ? [input.timeoutText] : [])].join("\n")),
      Actions([...buttons, LinkButton({ url: input.approvalUrl, label: "Open in UI" })]),
    ],
  });
}

/** The resolved card: the outcome line and a dashboard link, no answer buttons. */
export function buildResolvedChatApprovalCard(outcome: string, approvalUrl: string): CardElement {
  return Card({
    title: outcome,
    children: [Actions([LinkButton({ url: approvalUrl, label: "View" })])],
  });
}

async function handleApprovalAction(event: ActionEvent): Promise<void> {
  const outcome = await answerApprovalFromChat({
    requestId: event.value ?? "",
    choice: event.actionId.slice(CHAT_APPROVAL_ACTION_PREFIX.length),
    identity: { kind: event.adapter.name, externalId: event.user.userId },
  });
  // A resolve edits the card through the resolve hook; nothing else to say.
  if (outcome.kind === "resolved" || !event.thread) return;
  try {
    // Telegram has no ephemeral messages: the refusal goes to the clicker's DM, never the group.
    await event.thread.postEphemeral(event.user, outcome.message, { fallbackToDM: true });
  } catch (error) {
    console.warn(`[chat-sdk] Approval button reply not sent: ${errorMessage(error)}`);
  }
}

export function registerChatApprovalActions(chat: Chat): void {
  chat.onAction(async (event) => {
    if (!event.actionId.startsWith(CHAT_APPROVAL_ACTION_PREFIX) || !event.value) return;
    const work = handleApprovalAction(event);
    trackBackground(work);
    await work.catch(() => undefined);
  });
}
