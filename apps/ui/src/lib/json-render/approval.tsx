/**
 * `Approval` — one approval request (human-in-the-loop) answered inside an app page.
 *
 * - Data: `useLiveApprovalRequest` polls the request every 5 s while it is
 *   pending and stops once it resolves. The answer goes through the same
 *   respond call as the dashboard approvals page, with the viewer's bearer, so
 *   the server records the viewer and enforces approver lists and RBAC.
 * - Read-only: a role without `approval.respond`, or a server refusal (403),
 *   renders the questions with an "Open in dashboard" link instead of a form.
 * - 409 (resolved meanwhile, expired, already answered): refetch and show the
 *   server's state instead of an error.
 * - `onResolved` runs once, on a pending → resolved change this mount saw. A
 *   request that was already resolved on load does not run it, so a reload
 *   never repeats the follow-up. The chain gets `$chain` =
 *   `{ status, responses, resolvedBy }`.
 */

import type { InferComponentProps } from "@json-render/core";
import { useActions, useStateStore } from "@json-render/react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ExternalLink } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  useLiveApprovalRequest,
  useRespondToApprovalRequest,
} from "@/api/hooks/use-approval-requests";
import type { ApprovalRequest } from "@/api/types";
import { QuestionFlow, type QuestionFlowValues } from "@/components/shared/question-flow";
import { AnswerView } from "@/components/shared/questions/answer-view";
import { StatusBadge } from "@/components/shared/status-badge";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { quorumLabel, respondErrorMessage } from "@/lib/approval-format";
import { useCan } from "@/lib/use-can";
import { cn } from "@/lib/utils";
import { resolveScopedParams } from "./action-params";
import type { ActionChain, swarmCatalog } from "./catalog";

type ApprovalProps = InferComponentProps<typeof swarmCatalog, "Approval">;

const ROLE_CANNOT_ANSWER =
  "Your role cannot answer approval requests. An admin or an approver can.";

/** Dashboard page for one request; opens in a new tab so a chromeless embed keeps its page. */
function dashboardHref(id: string): string {
  return `/approval-requests/${encodeURIComponent(id)}`;
}

export function ApprovalComponent({ props }: { props: ApprovalProps }) {
  const requestId = typeof props.requestId === "string" ? props.requestId.trim() : "";
  // Empty until the creating action returns: the element can sit on the page early.
  if (!requestId) return null;
  // Keyed by id: a new request starts with a clean form and transition state.
  return <ApprovalRequestCard key={requestId} requestId={requestId} props={props} />;
}

function ApprovalRequestCard({ requestId, props }: { requestId: string; props: ApprovalProps }) {
  const { data: request, isLoading, isError, refetch } = useLiveApprovalRequest(requestId);
  const respond = useRespondToApprovalRequest();
  const queryClient = useQueryClient();
  const canRespond = useCan("approval.respond");
  const runResolved = useResolvedChainRunner(props.onResolved);
  /** The server refused this viewer's answer, or answered 409 with the request still pending. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** This viewer's answer was recorded but the approvers policy needs more. */
  const [recorded, setRecorded] = useState(false);

  const status = request?.status;
  const sawPending = useRef(false);
  const fired = useRef(false);
  useEffect(() => {
    if (!request || !status) return;
    if (status === "pending") {
      sawPending.current = true;
      return;
    }
    if (!sawPending.current || fired.current) return;
    fired.current = true;
    void runResolved({
      status,
      responses: request.responses ?? {},
      resolvedBy: request.resolvedBy,
    });
  }, [request, status, runResolved]);

  const compact = props.compact === true;

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2" data-testid="json-render-approval-loading">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (isError || !request) {
    return (
      <AlertCallout tone="error" icon={AlertCircle} title="Approval request unavailable">
        This request does not exist, or you cannot read it.
      </AlertCallout>
    );
  }

  const submit = async (values: QuestionFlowValues) => {
    try {
      const result = await respond.mutateAsync({ id: request.id, responses: values });
      // Swap in the server's view right away: no wait for the next poll.
      queryClient.setQueryData(["approval-request", request.id], result);
      if (result.approvalRequest.status === "pending") setRecorded(true);
    } catch (error) {
      const code = (error as { status?: unknown } | null)?.status;
      if (code === 409) {
        // Already answered, resolved or expired meanwhile: show the server's state.
        const fresh = await refetch();
        if (fresh.data?.status === "pending") setRefusal(respondErrorMessage(error));
        return;
      }
      if (code === 403) {
        setRefusal(respondErrorMessage(error));
        return;
      }
      throw new Error(respondErrorMessage(error));
    }
  };

  let body: ReactNode;
  if (request.status !== "pending") {
    body = <ResolvedBody request={request} showAnswers={props.showResolved !== false} />;
  } else if (recorded) {
    const quorum = quorumLabel(request.approvalProgress);
    body = (
      <Note>
        Your answer is recorded{quorum ? ` (${quorum})` : ""}. The request stays pending until the
        approvers policy is met.
      </Note>
    );
  } else if (!canRespond || refusal) {
    body = <ReadOnlyBody request={request} reason={refusal ?? ROLE_CANNOT_ANSWER} />;
  } else {
    body = (
      <QuestionFlow
        questions={request.questions}
        onSubmit={submit}
        done={() => <Note>Sending your answer…</Note>}
      />
    );
  }

  if (compact) {
    return (
      <div className="flex min-w-0 flex-col gap-3" data-testid="json-render-approval">
        {body}
      </div>
    );
  }
  return (
    <Card data-testid="json-render-approval">
      <CardHeader>
        <CardTitle className="min-w-0 wrap-anywhere">{request.title}</CardTitle>
        <CardAction>
          <StatusBadge status={request.status} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">{body}</CardContent>
    </Card>
  );
}

function ResolvedBody({
  request,
  showAnswers,
}: {
  request: ApprovalRequest;
  showAnswers: boolean;
}) {
  const outcome = <Note>{resolvedLine(request)}</Note>;
  if (!showAnswers || !request.responses) return outcome;
  const responses = request.responses;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="json-render-approval-answers">
      {request.questions.map((question) => (
        <div key={question.id} className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">{question.label}</span>
          <AnswerView question={question} response={responses[question.id]} />
        </div>
      ))}
      {outcome}
    </div>
  );
}

function ReadOnlyBody({ request, reason }: { request: ApprovalRequest; reason: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="json-render-approval-readonly">
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        {request.questions.map((question) => (
          <li key={question.id}>{question.label}</li>
        ))}
      </ul>
      <Note>{reason}</Note>
      <a
        href={dashboardHref(request.id)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary hover:underline"
      >
        Open in dashboard
        <ExternalLink className="size-3.5" aria-hidden />
      </a>
    </div>
  );
}

function Note({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <output className={cn("block text-xs text-muted-foreground", className)}>{children}</output>
  );
}

const RESOLVED_TEXT: Record<Exclude<ApprovalRequest["status"], "pending">, string> = {
  approved: "Approved",
  rejected: "Rejected",
  timeout: "Timed out with no answer",
  cancelled: "Cancelled",
};

function resolvedLine(request: ApprovalRequest): string {
  const text = RESOLVED_TEXT[request.status as Exclude<ApprovalRequest["status"], "pending">];
  return request.resolutionReason ? `${text}: ${request.resolutionReason}` : text;
}

/** Runs `onResolved` with `$chain` bound, read live so a re-render never runs a stale chain. */
function useResolvedChainRunner(chain: ActionChain | undefined) {
  const { execute } = useActions();
  const { getSnapshot } = useStateStore();
  const live = useRef({ chain, execute, getSnapshot });
  live.current = { chain, execute, getSnapshot };
  const runner = useRef(async (scope: Record<string, unknown>) => {
    const { chain: steps, execute: run, getSnapshot: snapshot } = live.current;
    if (!steps) return;
    for (const binding of steps) {
      const params = resolveScopedParams(binding.params, { chain: scope, state: snapshot() });
      await run({ ...binding, params });
    }
  });
  return runner.current;
}
