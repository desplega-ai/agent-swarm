import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  CircleX,
  Hourglass,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Streamdown } from "streamdown";
import {
  useRespondToApprovalRequest,
  useSessionApprovalRequest,
} from "@/api/hooks/use-approval-requests";
import { useWhoami } from "@/api/hooks/use-whoami";
import type { ApprovalRequest, SessionApproval } from "@/api/types";
import { AnimatedReveal } from "@/components/shared/animated-reveal";
import { QuestionFlow, type QuestionFlowValues } from "@/components/shared/question-flow";
import { AnswerView, WRAP } from "@/components/shared/questions/answer-view";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/contexts/current-user-context";
import {
  answerProgress,
  hasAnswered,
  quorumLabel,
  respondErrorMessage,
} from "@/lib/approval-format";
import { canAnswerInline, type InlineViewer, viewerResponder } from "@/lib/approval-inline";
import { useCan } from "@/lib/use-can";
import { cn, normalizeNewlines } from "@/lib/utils";

type Shown = { title: string; icon: LucideIcon; border: string; head: string; text: string };

const PENDING: Shown = {
  title: "Waiting for approval",
  icon: Hourglass,
  border: "border-status-active/30",
  head: "bg-status-active/5",
  text: "text-status-active-strong",
};

const NEUTRAL = { border: "border-border", head: "bg-muted/30", text: "text-muted-foreground" };

const RESOLVED: Record<Exclude<ApprovalRequest["status"], "pending">, Shown> = {
  approved: {
    title: "Approved",
    icon: CircleCheck,
    border: "border-status-success/30",
    head: "bg-status-success/5",
    text: "text-status-success-strong",
  },
  rejected: {
    title: "Rejected",
    icon: CircleX,
    border: "border-status-error/30",
    head: "bg-status-error/5",
    text: "text-status-error-strong",
  },
  timeout: { title: "Timed out with no answer", icon: CircleSlash, ...NEUTRAL },
  cancelled: { title: "Cancelled", icon: CircleSlash, ...NEUTRAL },
};

/**
 * An approval in the session (plan D6): the swarm waits on a person. One card
 * per request: the header (status, title, `Review ->`) toggles the body. When
 * the viewer may answer (`canAnswerInline`), the body is the form, one
 * question per tab, with Submit as the card footer; otherwise the card is
 * the header and `Review ->` alone. Pending cards open, resolved ones fold.
 */
export function ApprovalLine({
  approval,
  pending,
}: {
  approval: SessionApproval;
  /** Still in the session detail's pending list. `false` once it resolved anywhere. */
  pending: boolean;
}) {
  const { data: request, refetch } = useSessionApprovalRequest(approval.id);
  // The session detail polls; refetch once when the request leaves its pending list.
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current && !pending) void refetch();
    wasPending.current = pending;
  }, [pending, refetch]);
  const respond = useRespondToApprovalRequest();
  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  const whoami = useWhoami(true);
  const canRespond = useCan("approval.respond");
  /** This tab's answer was recorded but the approvers policy needs more. */
  const [recorded, setRecorded] = useState(false);
  /** Answers typed so far: the form unmounts while the card is folded. */
  const [draft, setDraft] = useState<QuestionFlowValues>({});
  /** A header toggle, kept only for the status it was made in. */
  const [toggled, setToggled] = useState<{ status: string; open: boolean } | null>(null);
  const bodyId = useId();

  const viewer: InlineViewer =
    whoami.data?.kind === "operator"
      ? { kind: "operator" }
      : whoami.data?.kind === "user" && whoami.data.user
        ? { kind: "user", user: whoami.data.user }
        : null;

  const status = request?.status ?? "pending";
  const shown = status === "pending" ? PENDING : RESOLVED[status];
  const answered =
    status === "pending" &&
    (recorded || (!!request && hasAnswered(request, viewerResponder(viewer))));
  const inline =
    status === "pending" && !!request && !answered && canAnswerInline(request, viewer, canRespond);
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

  let meta: string | null = null;
  let content: ReactNode = null;
  if (request && status !== "pending") {
    const { answered: n, total } = answerProgress(request.questions, request.responses ?? {});
    meta = `${n} of ${total} answered`;
    content = (
      <div className="flex flex-col gap-3 p-4 text-sm">
        {request.resolutionReason ? (
          <p className="wrap-anywhere text-muted-foreground">{request.resolutionReason}</p>
        ) : null}
        {request.responses ? (
          <dl className="flex flex-col gap-3">
            {request.questions.map((question) => (
              <div key={question.id} className="flex min-w-0 flex-col gap-1">
                <dt className={cn("text-xs text-muted-foreground [&_p]:my-0", WRAP)}>
                  <Streamdown>{normalizeNewlines(question.label)}</Streamdown>
                </dt>
                <dd>
                  <AnswerView question={question} response={request.responses?.[question.id]} />
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    );
    if (!request.resolutionReason && !request.responses) content = null;
  } else if (answered) {
    meta = `Your answer is recorded${quorum ? ` (${quorum})` : ""}`;
    content = (
      <p className="p-4 text-sm text-muted-foreground">
        The request stays pending until the approvers policy is met.
      </p>
    );
  } else if (inline && request) {
    const { answered: n, total } = answerProgress(request.questions, draft);
    meta = `${n} of ${total} answered`;
    content = (
      <QuestionFlow
        embedded
        questions={request.questions}
        initialValues={draft}
        onChange={setDraft}
        onSubmit={submit}
        done={() => (
          <output className="p-4 text-xs text-muted-foreground">Sending your answer…</output>
        )}
      />
    );
  }

  const collapsible = content !== null;
  const open = collapsible && (toggled?.status === status ? toggled.open : status === "pending");
  const Icon = shown.icon;
  const heading = (
    <>
      {collapsible ? (
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-snappy",
            open && "rotate-90",
          )}
        />
      ) : (
        // Keeps the title in line with the foldable cards above and below.
        <span aria-hidden className="size-4 shrink-0" />
      )}
      <Icon aria-hidden className={cn("size-4 shrink-0", shown.text)} />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium wrap-anywhere text-foreground">
          {request?.title ?? approval.title}
        </span>
        <span className="text-xs text-muted-foreground">
          <span className={shown.text}>{shown.title}</span>
          {meta ? ` · ${meta}` : null}
        </span>
      </span>
    </>
  );

  return (
    <section
      aria-label={`Approval: ${request?.title ?? approval.title}`}
      className={cn("min-w-0 overflow-hidden rounded-xl border bg-card", shown.border)}
      data-testid="session-approval"
    >
      <div className={cn("flex items-center gap-2 py-2 pr-3 pl-2", shown.head)}>
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={bodyId}
            onClick={() => setToggled({ status, open: !open })}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {heading}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2 p-1">{heading}</div>
        )}
        {/* Touch screens: a 44 px tap area (UX review R9). */}
        <Button asChild size="sm" variant="outline" className="hit-area [--hit-size:44px]">
          <Link to={`/approval-requests/${approval.id}`}>
            Review
            <ArrowRight />
          </Link>
        </Button>
      </div>
      <AnimatedReveal open={open}>
        <div id={bodyId} className="border-t border-border">
          {content}
        </div>
      </AnimatedReveal>
    </section>
  );
}
