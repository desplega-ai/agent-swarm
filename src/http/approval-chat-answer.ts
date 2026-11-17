import { type ApprovalRequest, getApprovalRequestById } from "../be/db";
import { recordUnmappedIdentity } from "../be/unmapped-identities";
import { findUserByExternalId } from "../be/users";
import { getAppUrl } from "../utils/constants";
import {
  type ApprovalQuestionLike,
  inlineApprovalQuestion,
  inlineApprovalResponses,
} from "../workflows/approval-inline";
import { updateResolvedApprovalCards } from "../workflows/approval-notifications";
import { answerApprovalRequest } from "./approval-requests";
import { userApprovalResponder } from "./person-responder";

export type ChatApprovalOutcome =
  /** Resolved; every card is edited by the resolve itself. */
  | { kind: "resolved"; request: ApprovalRequest }
  /** Not resolved, and nothing to show but `message` to the clicker alone. */
  | { kind: "recorded" | "refused"; message: string };

export interface ChatApprovalClick {
  requestId: string;
  /** See `InlineChoice.choice`. */
  choice: string;
  text?: string;
  /** The clicker on the platform: `kind` is the `user_external_ids` kind (`slack`, `telegram`). */
  identity: { kind: string; externalId: string };
}

function dashboardHint(requestId: string): string {
  return `Answer it on the dashboard: ${getAppUrl()}/approval-requests/${requestId}`;
}

/**
 * Answer an approval request from a chat button. The clicker must map through
 * `user_external_ids` to a user who may answer approvals and is one of the
 * request's approvers; anyone else gets a refusal and nothing is written. A
 * click on a request that is no longer pending re-renders its cards to the
 * final state, so a stale card catches up instead of erroring.
 */
export async function answerApprovalFromChat(
  click: ChatApprovalClick,
): Promise<ChatApprovalOutcome> {
  const { requestId, identity } = click;
  const request = await getApprovalRequestById(requestId);
  if (!request) return { kind: "refused", message: "This approval request no longer exists." };
  if (request.status !== "pending") return alreadyResolved(request);

  const user = await findUserByExternalId(identity.kind, identity.externalId);
  if (!user) {
    await recordUnmappedIdentity(identity.kind, identity.externalId, {
      sampleEventType: "approval_click",
      sampleContext: requestId,
    });
    return {
      kind: "refused",
      message: `Your ${identity.kind} account is not linked to a swarm user, so it cannot answer approvals. ${dashboardHint(requestId)}`,
    };
  }
  const responder = await userApprovalResponder(user.id);
  if (!responder.ok) return { kind: "refused", message: responder.message };

  const question = inlineApprovalQuestion(request.questions as ApprovalQuestionLike[]);
  const responses = question && inlineApprovalResponses(question, click.choice, click.text);
  if (!responses) {
    return {
      kind: "refused",
      message: `This button cannot answer it. ${dashboardHint(requestId)}`,
    };
  }

  const result = await answerApprovalRequest({
    id: requestId,
    responder: responder.responder,
    responses,
    via: { channel: identity.kind, platformUserId: identity.externalId },
  });
  if (result.kind === "resolved") return { kind: "resolved", request: result.request };
  if (result.kind === "recorded") {
    return {
      kind: "recorded",
      message: "Your answer is recorded. The request needs more approvals.",
    };
  }
  if (result.kind === "error" && result.status === 409) {
    // Lost the race to another answer, or the request expired on this click.
    const latest = await getApprovalRequestById(requestId);
    if (latest && latest.status !== "pending") return alreadyResolved(latest);
  }
  return {
    kind: "refused",
    message: result.kind === "error" ? result.message : "This answer was not saved.",
  };
}

async function alreadyResolved(request: ApprovalRequest): Promise<ChatApprovalOutcome> {
  // The claims make this a no-op for a card already showing the outcome.
  await updateResolvedApprovalCards([request]);
  return { kind: "refused", message: `This approval request is already ${request.status}.` };
}
