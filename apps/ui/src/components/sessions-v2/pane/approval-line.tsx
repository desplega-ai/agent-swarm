import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, CircleSlash, CircleX, Hourglass } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useLiveApprovalRequest,
  useRespondToApprovalRequest,
} from "@/api/hooks/use-approval-requests";
import { useWhoami } from "@/api/hooks/use-whoami";
import type { ApprovalRequest, SessionApproval } from "@/api/types";
import { QuestionFlow, type QuestionFlowValues } from "@/components/shared/question-flow";
import { AlertCallout, type AlertCalloutTone } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/contexts/current-user-context";
import { hasAnswered, quorumLabel, respondErrorMessage } from "@/lib/approval-format";
import { canAnswerInline, type InlineViewer, viewerResponder } from "@/lib/approval-inline";
import { useCan } from "@/lib/use-can";

type Resolved = Exclude<ApprovalRequest["status"], "pending">;

const RESOLVED: Record<
  Resolved,
  { title: string; tone: AlertCalloutTone; icon: typeof Hourglass }
> = {
  approved: { title: "Approved", tone: "success", icon: CircleCheck },
  rejected: { title: "Rejected", tone: "error", icon: CircleX },
  timeout: { title: "Timed out with no answer", tone: "neutral", icon: CircleSlash },
  cancelled: { title: "Cancelled", tone: "neutral", icon: CircleSlash },
};

/**
 * An approval in the session (plan D6): the swarm waits on a person. When the
 * viewer may answer it (`canAnswerInline`), the form renders under the card;
 * otherwise only `Review ->` opens the full page. The card follows the
 * request's live status, so it turns resolved after an answer here or anywhere.
 */
export function ApprovalLine({ approval }: { approval: SessionApproval }) {
  const { data: request } = useLiveApprovalRequest(approval.id);
  const respond = useRespondToApprovalRequest();
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  const whoami = useWhoami(true);
  const canRespond = useCan("approval.respond");
  /** This tab's answer was recorded but the approvers policy needs more. */
  const [recorded, setRecorded] = useState(false);

  const viewer: InlineViewer =
    whoami.data?.kind === "operator"
      ? { kind: "operator" }
      : whoami.data?.kind === "user" && whoami.data.user
        ? { kind: "user", user: whoami.data.user }
        : null;

  const review = (
    // Touch screens: a 44 px tap area (UX review R9).
    <Button asChild size="sm" variant="outline" className="hit-area [--hit-size:44px]">
      <Link to={`/approval-requests/${approval.id}`}>
        Review
        <ArrowRight />
      </Link>
    </Button>
  );

  if (request && request.status !== "pending") {
    const shown = RESOLVED[request.status];
    return (
      <AlertCallout
        tone={shown.tone}
        icon={shown.icon}
        title={shown.title}
        role="note"
        action={review}
      >
        <span className="text-sm wrap-anywhere text-foreground">{request.title}</span>
        {request.resolutionReason ? (
          <span className="block wrap-anywhere">{request.resolutionReason}</span>
        ) : null}
      </AlertCallout>
    );
  }

  const answered = recorded || (!!request && hasAnswered(request, viewerResponder(viewer)));
  const inline = !!request && !answered && canAnswerInline(request, viewer, canRespond);
  const quorum = request ? quorumLabel(request.approvalProgress) : null;

  const submit = async (values: QuestionFlowValues) => {
    if (!request) return;
    try {
      const result = await respond.mutateAsync({
        id: request.id,
        responses: values,
        // Display hint only, as on the full page: the server records the credential.
        claimedRespondedBy: user?.email ?? user?.name ?? undefined,
      });
      // Swap in the server's view at once: no wait for the next poll.
      queryClient.setQueryData(["approval-request", request.id], result);
      if (result.approvalRequest.status === "pending") setRecorded(true);
    } catch (error) {
      throw new Error(respondErrorMessage(error));
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="session-approval">
      <AlertCallout
        tone="active"
        icon={Hourglass}
        title="Waiting for approval"
        // Part of the timeline, not news: no alert on every open.
        role="note"
        action={review}
      >
        <span className="text-sm wrap-anywhere text-foreground">
          {request?.title ?? approval.title}
        </span>
        {answered ? (
          <span className="block">
            Your answer is recorded{quorum ? ` (${quorum})` : ""}. The request stays pending until
            the approvers policy is met.
          </span>
        ) : null}
      </AlertCallout>
      {inline && request ? (
        <QuestionFlow
          questions={request.questions}
          onSubmit={submit}
          done={() => (
            <output className="text-xs text-muted-foreground">Sending your answer…</output>
          )}
        />
      ) : null}
    </div>
  );
}
