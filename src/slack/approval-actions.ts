import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { getApprovalRequestById } from "../be/db";
import { answerApprovalFromChat } from "../http/approval-chat-answer";
import {
  type ApprovalQuestionLike,
  INLINE_TEXT_MAX_LENGTH,
  type InlineApprovalQuestion,
  inlineApprovalChoices,
  inlineApprovalQuestion,
} from "../workflows/approval-inline";
import { APPROVAL_ACTION_PREFIX } from "./approval-buttons";
import { EXTERNAL_CHANNEL_BLOCKED_REPLY, shouldBlockChannel } from "./external-channel";
import { ignoreSlackInbound, noteSlackInboundSideEffect } from "./inbound-dispatch";

const APPROVAL_MODAL_CALLBACK = "hitl_answer_modal";

interface ModalMetadata {
  r: string;
  c: string;
  ch?: string;
}

function answerModal(
  question: InlineApprovalQuestion,
  metadata: ModalMetadata,
): Record<string, unknown> {
  const deny = question.type === "approval";
  return {
    type: "modal",
    callback_id: APPROVAL_MODAL_CALLBACK,
    private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: deny ? "Deny" : "Answer" },
    submit: { type: "plain_text", text: deny ? "Deny" : "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "answer",
        optional: deny,
        label: {
          type: "plain_text",
          text: deny ? "Reason (optional)" : question.label.slice(0, 2000) || "Answer",
        },
        element: {
          type: "plain_text_input",
          action_id: "text",
          max_length: INLINE_TEXT_MAX_LENGTH,
        },
      },
    ],
  };
}

async function tellClicker(
  client: WebClient,
  channelId: string | undefined,
  userId: string,
  text: string,
): Promise<void> {
  if (!channelId) return;
  try {
    await client.chat.postEphemeral({ channel: channelId, user: userId, text });
  } catch (error) {
    console.error("[Slack] Failed to post approval button reply:", error);
  }
}

async function answer(
  client: WebClient,
  input: {
    requestId: string;
    choice: string;
    text?: string;
    slackUserId: string;
    channelId?: string;
  },
): Promise<void> {
  noteSlackInboundSideEffect("approval_answer");
  const outcome = await answerApprovalFromChat({
    requestId: input.requestId,
    choice: input.choice,
    text: input.text,
    identity: { kind: "slack", externalId: input.slackUserId },
  });
  if (outcome.kind !== "resolved") {
    await tellClicker(client, input.channelId, input.slackUserId, outcome.message);
  }
}

export function registerApprovalActionHandlers(app: App): void {
  app.action(new RegExp(`^${APPROVAL_ACTION_PREFIX}`), async ({ ack, action, body, client }) => {
    await ack();
    if (action.type !== "button" || !("action_id" in action)) return;
    const requestId = action.value;
    const choice = action.action_id.slice(APPROVAL_ACTION_PREFIX.length);
    if (!requestId || !choice) return ignoreSlackInbound("approval_action_malformed");

    const channelId = "channel" in body ? body.channel?.id : undefined;
    if (channelId && (await shouldBlockChannel(client, channelId))) {
      await tellClicker(client, channelId, body.user.id, EXTERNAL_CHANNEL_BLOCKED_REPLY);
      return ignoreSlackInbound("external_channel");
    }

    const request = await getApprovalRequestById(requestId);
    const question = request
      ? inlineApprovalQuestion(request.questions as ApprovalQuestionLike[])
      : null;
    const needsText = question
      ? inlineApprovalChoices(question).find((c) => c.choice === choice)?.needsText
      : undefined;
    const triggerId = "trigger_id" in body ? body.trigger_id : undefined;
    // A pending request opens the modal; anything else is answered now so a stale card catches up.
    if (question && needsText && triggerId && request?.status === "pending") {
      try {
        await client.views.open({
          trigger_id: triggerId,
          // biome-ignore lint/suspicious/noExplicitAny: Block Kit objects
          view: answerModal(question, { r: requestId, c: choice, ch: channelId }) as any,
        });
      } catch (error) {
        console.error("[Slack] Failed to open the approval answer modal:", error);
        await tellClicker(client, channelId, body.user.id, "Could not open the answer form.");
      }
      return;
    }
    await answer(client, { requestId, choice, slackUserId: body.user.id, channelId });
  });

  app.view(APPROVAL_MODAL_CALLBACK, async ({ ack, view, body, client }) => {
    await ack();
    let metadata: ModalMetadata;
    try {
      metadata = JSON.parse(view.private_metadata) as ModalMetadata;
    } catch {
      return ignoreSlackInbound("approval_modal_malformed");
    }
    if (!metadata.r || !metadata.c) return ignoreSlackInbound("approval_modal_malformed");
    const text = view.state.values.answer?.text?.value ?? "";
    await answer(client, {
      requestId: metadata.r,
      choice: metadata.c,
      text,
      slackUserId: body.user.id,
      channelId: metadata.ch,
    });
  });
}
