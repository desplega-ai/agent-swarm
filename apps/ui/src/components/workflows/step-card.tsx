import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Code2, Timer } from "lucide-react";
import { forwardRef, useState } from "react";
import { Link } from "react-router-dom";
import { useApprovalRequests } from "@/api/hooks/use-approval-requests";
import { useWorkflow, useWorkflowRunSlim } from "@/api/hooks/use-workflows";
import type { WorkflowNode, WorkflowRunStep } from "@/api/types";
import { Spinner } from "@/components/kibo-ui/spinner";
import { AgentLink } from "@/components/shared/agent-link";
import { JsonTree } from "@/components/shared/json-tree";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { effectiveChildStatus } from "@/components/workflows/graph-utils";
import { foreachParentIds, parseSyntheticStepId } from "@/lib/synthetic-step-id";
import { cn, formatElapsed, formatSmartTime } from "@/lib/utils";

export interface StepCardProps {
  step: WorkflowRunStep;
  workflowNodes?: WorkflowNode[];
  isSelected: boolean;
  isExpanded: boolean;
  onClick: () => void;
  onToggleExpand: () => void;
  /** Rendered inside a `foreach` group — the parent label is already on the group header. */
  inGroup?: boolean;
  /** A foreach item's earlier attempt rows, oldest first. `step` is the latest attempt. */
  earlierAttempts?: WorkflowRunStep[];
}

/** Format a byte count as a human-readable string (B, KB, MB). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Safely get the JSON string length of a value for byte-size display. */
function jsonByteSize(value: unknown): number {
  try {
    return typeof value === "string" ? value.length : JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

/** Parse diagnostics JSON string, returning null on failure. */
function parseDiagnostics(raw: string | undefined): { unresolvedTokens?: string[] } | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const StepCard = forwardRef<HTMLDivElement, StepCardProps>(
  (
    {
      step,
      workflowNodes,
      isSelected,
      isExpanded,
      onClick,
      onToggleExpand,
      inGroup,
      earlierAttempts = [],
    },
    ref,
  ) => {
    // `foreach` children carry synthetic `<parentNodeId>#<itemKey>` ids — the definition only holds
    // the parent node, so label and config always resolve against the parent.
    const { parentNodeId, itemKey } = parseSyntheticStepId(
      step.nodeId,
      foreachParentIds(workflowNodes),
    );
    const node = workflowNodes?.find((n) => n.id === parentNodeId);
    const label = node?.label || parentNodeId;
    const duration =
      step.startedAt && step.finishedAt ? formatElapsed(step.startedAt, step.finishedAt) : null;

    const diagnostics = parseDiagnostics(step.diagnostics);
    const unresolvedTokens = diagnostics?.unresolvedTokens;

    // An onNodeFailure:"continue" child completes WITH a persisted error — badge it as failed,
    // matching the graph's classification and the group's ok/failed chip.
    const displayStatus = itemKey ? effectiveChildStatus(step) : step.status;

    // Foreach children carry their zero-based iteration in step.input — badge them with the
    // body's executor type plus the iteration: `<nodeType> · #<iteration>`.
    const iteration =
      itemKey && typeof step.input === "object" && step.input !== null
        ? (step.input as Record<string, unknown>).index
        : undefined;
    const typeBadge =
      itemKey != null
        ? `${step.nodeType} · ${typeof iteration === "number" ? `#${iteration}` : "item"}`
        : step.nodeType;

    return (
      <div
        ref={ref}
        onClick={onClick}
        className={cn(
          "rounded-md border bg-background transition-colors cursor-pointer",
          // Same selection language as the graph nodes: a primary ring + soft glow
          // (scaled down for list density) instead of a barely-visible left border.
          isSelected &&
            "ring-2 ring-primary ring-offset-1 ring-offset-background shadow-md shadow-primary/30",
        )}
      >
        {/* Header row - always visible */}
        <div className="w-full flex items-center gap-2 px-3 py-2">
          {inGroup && itemKey ? (
            <span className="text-sm font-medium font-mono truncate">{itemKey}</span>
          ) : (
            <>
              <span className="text-sm font-medium truncate">{label}</span>

              {itemKey && (
                <span className="text-xs text-muted-foreground font-mono truncate">
                  &middot; {itemKey}
                </span>
              )}
            </>
          )}

          <Badge
            variant="outline"
            size="tag"
            className={cn(
              "shrink-0",
              (itemKey != null || step.nodeType === "foreach") &&
                "border-action-foreach/40 text-action-foreach",
              itemKey == null &&
                step.nodeType === "sub-workflow" &&
                "border-action-sub-workflow/40 text-action-sub-workflow",
              itemKey == null &&
                step.nodeType === "system-one-decision" &&
                "border-action-system-one-decision/40 text-action-system-one-decision",
              itemKey == null &&
                step.nodeType === "system-one-extraction" &&
                "border-action-system-one-extraction/40 text-action-system-one-extraction",
            )}
          >
            {typeBadge}
          </Badge>

          {step.nextPort && step.nextPort !== "default" && (
            <Badge
              variant="outline"
              size="tag"
              className="shrink-0 border-status-info/30 text-status-info-strong"
            >
              port: {step.nextPort}
            </Badge>
          )}

          <StatusBadge status={displayStatus} className="shrink-0" />

          {earlierAttempts.length > 0 && (
            <Badge
              variant="outline"
              size="tag"
              className="shrink-0 border-status-active/30 text-status-active-strong"
            >
              attempt {earlierAttempts.length + 1}
            </Badge>
          )}

          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            {duration && (
              <span className="text-xs text-muted-foreground font-mono flex items-center gap-1">
                <Timer className="h-3 w-3" />
                {duration}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand();
              }}
              className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              title={isExpanded ? "Collapse" : "Expand"}
            >
              {isExpanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Expanded details */}
        {isExpanded && (
          <div className="px-3 pb-3 pt-1 space-y-3 border-t">
            {/* Metadata grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <MetaField label="Started" value={formatSmartTime(step.startedAt)} />
              {step.finishedAt && (
                <MetaField label="Finished" value={formatSmartTime(step.finishedAt)} />
              )}
              {duration && <MetaField label="Duration" value={duration} mono />}
            </div>

            {/* Agent info (from node config) */}
            <AgentInfo node={node} />

            {/* HITL config (title & questions) — only when waiting, resolved shows Q&A in output */}
            {step.nodeType === "human-in-the-loop" && node && step.output == null && (
              <HitlConfig node={node} />
            )}

            {/* Notify config */}
            {step.nodeType === "notify" && node && <NotifyConfig node={node} />}

            {/* Retry info */}
            {step.retryCount != null && step.retryCount > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <Badge variant="outline" size="tag" className="text-status-active-strong">
                  Retry {step.retryCount}
                  {step.maxRetries != null ? `/${step.maxRetries}` : ""}
                </Badge>
                {step.nextRetryAt && (
                  <span className="text-muted-foreground">
                    next: {formatSmartTime(step.nextRetryAt)}
                  </span>
                )}
              </div>
            )}

            {/* Diagnostics warnings */}
            {unresolvedTokens && unresolvedTokens.length > 0 && (
              <div className="flex items-start gap-2 text-xs text-status-active-strong">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>Unresolved tokens: {unresolvedTokens.map((t) => `{{${t}}}`).join(", ")}</span>
              </div>
            )}

            {/* Error */}
            {step.error && (
              <Alert variant="destructive" className="py-2">
                <AlertCircle className="h-3.5 w-3.5" />
                <AlertDescription className="text-xs font-mono whitespace-pre-wrap">
                  {step.error}
                </AlertDescription>
              </Alert>
            )}

            {/* Input */}
            {step.input != null && (
              <div className="space-y-1">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">Input</span>
                <JsonTree data={step.input} defaultExpandDepth={1} maxHeight="200px" />
              </div>
            )}

            {/* Output — smart rendering by nodeType */}
            <StepOutput step={step} node={node} />

            {earlierAttempts.length > 0 && (
              <AttemptHistory attempts={earlierAttempts} node={node} />
            )}
          </div>
        )}
      </div>
    );
  },
);
StepCard.displayName = "StepCard";

// --- Smart Output Rendering ---

function StepOutput({ step, node }: { step: WorkflowRunStep; node?: WorkflowNode }) {
  if (step.nodeType === "agent-task") {
    return <AgentTaskOutput step={step} />;
  }

  if (step.nodeType === "human-in-the-loop") {
    return <HitlOutput step={step} node={node} />;
  }

  if (step.nodeType === "script" || step.nodeType === "raw-llm") {
    return <ScriptOutput step={step} />;
  }

  if (step.nodeType === "system-one-decision") {
    return <SystemOneOutput step={step} node={node} />;
  }

  if (step.nodeType === "system-one-extraction") {
    return <SystemOneExtractionOutput step={step} />;
  }

  if (step.nodeType === "sub-workflow") {
    return <SubWorkflowOutput step={step} />;
  }

  // Generic fallback for other step types
  return <GenericOutput step={step} />;
}

function AgentTaskOutput({ step }: { step: WorkflowRunStep }) {
  const output = step.output as Record<string, unknown> | null | undefined;

  // Waiting state — output is null and step is not terminal
  if (output == null) {
    if (step.status === "running" || step.status === "waiting" || step.status === "pending") {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
          <Spinner className="size-3.5" />
          <span>Task in progress</span>
        </div>
      );
    }
    return null;
  }

  const taskId = typeof output.taskId === "string" ? output.taskId : null;
  const taskOutput = output.taskOutput;

  return (
    <div className="space-y-2">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">Output</span>

      {/* Task ID link */}
      {taskId && (
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Task</span>
          <Link
            to={`/tasks/${taskId}`}
            className="text-primary hover:underline font-mono text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            &rarr; {taskId.slice(0, 8)}
          </Link>
        </div>
      )}

      {/* Task output — collapsible with byte size */}
      {taskOutput != null && <CollapsibleOutput label="output" data={taskOutput} />}

      {/* Raw JSON toggle for full output object */}
      <RawJsonToggle data={output} />
    </div>
  );
}

export function HitlOutput({ step, node }: { step: WorkflowRunStep; node?: WorkflowNode }) {
  const output = step.output as
    | {
        requestId: string;
        status: "approved" | "rejected" | "timeout" | "cancelled";
        responses: Record<string, unknown> | null;
      }
    | null
    | undefined;

  // Waiting state — no output yet
  if (output == null) {
    if (step.status === "waiting") {
      return (
        <div className="flex items-center gap-2 text-xs text-status-active-strong py-1">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-active opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-status-active" />
          </span>
          <span>Awaiting approval</span>
        </div>
      );
    }
    return null;
  }

  const requestId = typeof output.requestId === "string" ? output.requestId : null;
  const questions =
    node?.config && Array.isArray(node.config.questions)
      ? (node.config.questions as Array<{
          id?: string;
          type?: string;
          label?: string;
          description?: string;
          options?: string[];
        }>)
      : null;
  const responses = output.responses;

  const statusBadgeClass =
    output.status === "approved"
      ? "border-status-success/30 text-status-success-strong"
      : output.status === "rejected"
        ? "border-status-error/30 text-status-error-strong"
        : output.status === "cancelled"
          ? "border-border text-muted-foreground"
          : "border-status-active/30 text-status-active-strong";
  const statusLabel =
    output.status === "approved"
      ? "Approved"
      : output.status === "rejected"
        ? "Rejected"
        : output.status === "cancelled"
          ? "Cancelled"
          : "Timed out";

  return (
    <div className="space-y-2">
      {/* Status + branch + request link */}
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" size="tag" className={`${statusBadgeClass}`}>
          {statusLabel}
        </Badge>
        {step.nextPort && step.nextPort !== "default" && (
          <span className="text-[10px] text-muted-foreground">
            branch: <span className="font-mono">{step.nextPort}</span>
          </span>
        )}
        {requestId && (
          <Link
            to={`/approval-requests/${requestId}`}
            className="text-primary hover:underline font-mono text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            &rarr; {requestId.slice(0, 8)}
          </Link>
        )}
      </div>

      {/* Questions + Answers merged */}
      {questions && questions.length > 0 && responses && (
        <div className="space-y-1.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Questions &amp; Answers
          </span>
          <div className="space-y-1.5">
            {questions.map((q, i) => {
              const answer = q.id ? responses[q.id] : undefined;
              return (
                <div
                  key={q.id ?? i}
                  className="rounded-md border border-border/50 px-3 py-2 space-y-1"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" size="tag" className="shrink-0">
                      {q.type ?? "unknown"}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {q.label ?? q.id ?? `Question ${i + 1}`}
                    </span>
                  </div>
                  {answer !== undefined && (
                    <div className="text-xs font-medium pl-0.5">
                      {typeof answer === "boolean" ? (
                        <span
                          className={
                            answer ? "text-status-success-strong" : "text-status-error-strong"
                          }
                        >
                          {answer ? "Yes" : "No"}
                        </span>
                      ) : typeof answer === "string" ? (
                        <span className="text-foreground">&ldquo;{answer}&rdquo;</span>
                      ) : (
                        <span className="font-mono text-foreground">{JSON.stringify(answer)}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Fallback: show raw responses if no questions to match against */}
      {(!questions || questions.length === 0) && responses != null && (
        <CollapsibleOutput label="responses" data={responses} />
      )}

      {/* Raw JSON toggle for full output */}
      <RawJsonToggle data={output} />
    </div>
  );
}

function ScriptOutput({ step }: { step: WorkflowRunStep }) {
  if (step.output == null) return null;

  // String output — render as pre
  if (typeof step.output === "string") {
    return (
      <div className="space-y-2">
        <span className="text-xs text-muted-foreground uppercase tracking-wide">Output</span>
        <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed rounded-md bg-muted p-3 text-muted-foreground max-h-[300px] overflow-y-auto">
          {step.output}
        </pre>
        <RawJsonToggle data={step.output} />
      </div>
    );
  }

  // Object output
  return (
    <div className="space-y-2">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">Output</span>
      <CollapsibleOutput label="output" data={step.output} />
      <RawJsonToggle data={step.output} />
    </div>
  );
}

function GenericOutput({ step }: { step: WorkflowRunStep }) {
  if (step.output == null) return null;

  if (typeof step.output === "string") {
    return (
      <div className="space-y-2">
        <span className="text-xs text-muted-foreground uppercase tracking-wide">Output</span>
        <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed rounded-md bg-muted p-3 text-muted-foreground max-h-[300px] overflow-y-auto">
          {step.output}
        </pre>
        <RawJsonToggle data={step.output} />
      </div>
    );
  }

  // Object output — collapsible
  return (
    <div className="space-y-2">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">Output</span>
      <CollapsibleOutput label="output" data={step.output} />
      <RawJsonToggle data={step.output} />
    </div>
  );
}

type SystemOneAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number }
  | { type: "score"; score: number; confidence: number };

type SystemOneReviewQuestion = {
  confidence: number;
  inBand: boolean;
  decidedBy: "model" | "human";
  modelAnswer?: string | number;
};

type SystemOneDecision = {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
  routing?: { model: string };
  review?: {
    status: "not_required" | "pending" | "approved" | "rejected" | "timeout";
    approvalRequestId?: string;
    reason?: string;
    questions: Record<string, SystemOneReviewQuestion>;
  };
};

const REVIEW_STATUS: Record<string, { label: string; className: string }> = {
  not_required: { label: "No review needed", className: "border-border text-muted-foreground" },
  pending: {
    label: "Awaiting review",
    className: "border-status-active/30 text-status-active-strong",
  },
  approved: {
    label: "Review approved",
    className: "border-status-success/30 text-status-success-strong",
  },
  rejected: {
    label: "Review rejected",
    className: "border-status-error/30 text-status-error-strong",
  },
  timeout: {
    label: "Review timed out",
    className: "border-status-active/30 text-status-active-strong",
  },
};

function formatAnswer(answer: SystemOneAnswer): string {
  if (answer.type === "choice") return answer.choice;
  if (answer.type === "score") return String(answer.score);
  return answer.noul.toFixed(2);
}

/** The confidence shown for an answer: the review's tested number, else the answer's own. */
function answerConfidence(
  answer: SystemOneAnswer,
  review?: SystemOneReviewQuestion,
): number | null {
  if (review) return review.confidence;
  return answer.type === "noul" ? null : answer.confidence;
}

function ConfidenceBar({
  value,
  fill = "bg-action-system-one-decision",
}: {
  value: number;
  fill?: string;
}) {
  const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <div className="flex items-center gap-1.5" title={`confidence ${value}`}>
      <div className="h-1.5 w-16 rounded-full bg-muted overflow-hidden">
        <div className={cn("h-full", fill)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-muted-foreground">{pct}%</span>
    </div>
  );
}

/** A `system-one-decision` step: each question's answer, how sure the model was, and who decided. */
export function SystemOneOutput({ step, node }: { step: WorkflowRunStep; node?: WorkflowNode }) {
  const output = step.output as SystemOneDecision | null | undefined;

  if (output == null || typeof output !== "object" || !output.answers) {
    if (step.status === "running" || step.status === "pending") {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
          <Spinner className="size-3.5" />
          <span>Asking the model</span>
        </div>
      );
    }
    return <GenericOutput step={step} />;
  }

  const review = output.review;
  const reviewStatus = review ? REVIEW_STATUS[review.status] : undefined;
  const model = output.routing?.model ?? output.model;

  return (
    <div className="space-y-2">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">Decision</span>
      <div className="flex items-center gap-2 flex-wrap">
        {reviewStatus && (
          <Badge variant="outline" size="tag" className={reviewStatus.className}>
            {reviewStatus.label}
          </Badge>
        )}
        <Badge variant="outline" size="tag" className="font-mono">
          {model}
        </Badge>
        {review?.approvalRequestId && (
          <Link
            to={`/approval-requests/${review.approvalRequestId}`}
            className="text-primary hover:underline font-mono text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            &rarr; {review.approvalRequestId.slice(0, 8)}
          </Link>
        )}
      </div>

      {review?.status === "pending" && step.status === "waiting" && (
        <PendingReview step={step} node={node} />
      )}

      {review?.reason && <p className="text-xs text-status-error-strong">{review.reason}</p>}

      <div className="space-y-1.5">
        {Object.entries(output.answers).map(([id, answer]) => {
          const question = review?.questions[id];
          const confidence = answerConfidence(answer, question);
          const decidedBy = question?.decidedBy ?? "model";
          return (
            <div
              key={id}
              className="rounded-md border border-border/50 px-3 py-2 flex items-center gap-2 flex-wrap"
            >
              <span className="text-xs text-muted-foreground font-mono">{id}</span>
              <span className="text-xs font-medium">{formatAnswer(answer)}</span>
              {confidence != null && <ConfidenceBar value={confidence} />}
              <Badge
                variant="outline"
                size="tag"
                className={cn(
                  "ml-auto",
                  decidedBy === "human" && "border-status-info/30 text-status-info-strong",
                )}
              >
                decided by {decidedBy}
              </Badge>
              {question?.inBand && decidedBy === "model" && (
                <Badge
                  variant="outline"
                  size="tag"
                  className="border-status-active/30 text-status-active-strong"
                >
                  in review band
                </Badge>
              )}
              {decidedBy === "human" && question?.modelAnswer !== undefined && (
                <span className="w-full text-[10px] text-muted-foreground">
                  model said {String(question.modelAnswer)}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {output.usage && (
        <p className="text-[10px] text-muted-foreground font-mono">
          {output.usage.input_tokens} in · {output.usage.output_tokens} out tokens
        </p>
      )}

      <RawJsonToggle data={output} />
    </div>
  );
}

type ExtractionPoint = number | string;

type SystemOneExtractionAnswer = {
  type: string;
  value: unknown;
  guess?: unknown;
  p_null?: number;
  confidence?: number;
  unit?: string;
  median?: ExtractionPoint | ExtractionPoint[];
  p10?: ExtractionPoint | ExtractionPoint[];
  p90?: ExtractionPoint | ExtractionPoint[];
};

type SystemOneExtraction = {
  model: string;
  answers: Record<string, SystemOneExtractionAnswer>;
  usage?: { input_tokens: number; output_tokens: number };
  truncated?: boolean;
};

function showPoints(value: ExtractionPoint | ExtractionPoint[] | undefined): string {
  if (value === undefined) return "?";
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/**
 * An extracted value as one line: a list joined, a range for estimates and forecasts.
 * An estimate's `value` (Clairic's rounded mean) can differ from its median, so both show.
 */
function formatExtracted(answer: SystemOneExtractionAnswer): string {
  if (answer.type === "estimate" || answer.type === "forecast") {
    const range = `p10 ${showPoints(answer.p10)} – p90 ${showPoints(answer.p90)}`;
    if (
      answer.type === "estimate" &&
      (typeof answer.value === "number" || typeof answer.value === "string")
    ) {
      return `${answer.value} · median ${showPoints(answer.median)} (${range})`;
    }
    return `${showPoints(answer.median)} (${range})`;
  }
  if (Array.isArray(answer.value)) {
    return answer.value.length > 0 ? answer.value.map(String).join(", ") : "(none)";
  }
  return String(answer.value);
}

/** A `system-one-extraction` step: each field's value, how sure the model was, and what it would have guessed. */
export function SystemOneExtractionOutput({ step }: { step: WorkflowRunStep }) {
  const output = step.output as SystemOneExtraction | null | undefined;

  if (output == null || typeof output !== "object" || !output.answers) {
    if (step.status === "running" || step.status === "pending") {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
          <Spinner className="size-3.5" />
          <span>Reading the input</span>
        </div>
      );
    }
    return <GenericOutput step={step} />;
  }

  return (
    <div className="space-y-2">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">Extraction</span>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" size="tag" className="font-mono">
          {output.model}
        </Badge>
        {output.truncated && (
          <Badge
            variant="outline"
            size="tag"
            className="border-status-active/30 text-status-active-strong"
          >
            input truncated
          </Badge>
        )}
      </div>

      <div className="space-y-1.5">
        {Object.entries(output.answers).map(([id, answer]) => {
          const missing = answer.value === null;
          return (
            <div
              key={id}
              className="rounded-md border border-border/50 px-3 py-2 flex items-center gap-2 flex-wrap"
            >
              <span className="text-xs text-muted-foreground font-mono">{id}</span>
              <Badge variant="outline" size="tag" className="font-mono">
                {answer.type}
              </Badge>
              {missing ? (
                <span className="text-xs text-muted-foreground italic">not in the input</span>
              ) : (
                <span className="text-xs font-medium break-all">
                  {formatExtracted(answer)}
                  {answer.unit ? ` ${answer.unit}` : ""}
                </span>
              )}
              {answer.confidence != null && (
                <span className="ml-auto">
                  <ConfidenceBar value={answer.confidence} fill="bg-action-system-one-extraction" />
                </span>
              )}
              {missing && answer.guess != null && (
                <span className="w-full text-[10px] text-muted-foreground">
                  best guess {String(answer.guess)}
                  {answer.p_null != null ? ` · p(null) ${answer.p_null.toFixed(3)}` : ""}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {output.usage && (
        <p className="text-[10px] text-muted-foreground font-mono">
          {output.usage.input_tokens} in · {output.usage.output_tokens} out tokens
        </p>
      )}

      <RawJsonToggle data={output} />
    </div>
  );
}

/** The approval request a parked `system-one-decision` step is waiting on. */
function PendingReview({ step, node }: { step: WorkflowRunStep; node?: WorkflowNode }) {
  const { data: requests } = useApprovalRequests({ workflowRunId: step.runId });
  const request = requests?.find((r) => r.workflowRunStepId === step.id && r.status === "pending");
  const humanReview = node?.config?.humanReview as
    | { band?: { min?: number; max?: number } }
    | undefined;
  const band = humanReview?.band;

  return (
    <div className="flex items-center gap-2 text-xs text-status-active-strong py-1 flex-wrap">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-status-active opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-status-active" />
      </span>
      <span>{request ? request.title : "Awaiting approval"}</span>
      {request && (
        <Link
          to={`/approval-requests/${request.id}`}
          className="text-primary hover:underline font-mono"
          onClick={(e) => e.stopPropagation()}
        >
          &rarr; {request.id.slice(0, 8)}
        </Link>
      )}
      {typeof band?.min === "number" && typeof band?.max === "number" && (
        <span className="text-muted-foreground">
          review band {band.min}–{band.max}
        </span>
      )}
    </div>
  );
}

type SubWorkflowStepOutput = {
  runId: string;
  outputs: Record<string, unknown>;
  error?: string;
};

/** A `sub-workflow` step: the child run's status and each child node's result. */
export function SubWorkflowOutput({ step }: { step: WorkflowRunStep }) {
  const output = step.output as SubWorkflowStepOutput | null | undefined;
  const runId = output && typeof output.runId === "string" ? output.runId : "";
  // Only the child's status and step statuses are shown, so skip its context and step inputs.
  const { data: childRun } = useWorkflowRunSlim(runId);
  const { data: childWorkflow } = useWorkflow(childRun?.workflowId ?? "");

  if (output == null || !runId) {
    if (step.status === "running" || step.status === "waiting" || step.status === "pending") {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
          <Spinner className="size-3.5" />
          <span>Waiting for the child run</span>
        </div>
      );
    }
    return <GenericOutput step={step} />;
  }

  const nodes = childWorkflow?.definition.nodes;
  // Latest step per node wins, as on the graph.
  const childSteps = new Map((childRun?.steps ?? []).map((s) => [s.nodeId, s]));
  // `run` is the engine's `{ id }` context entry, not a node result.
  const results = Object.entries(output.outputs ?? {}).filter(([key]) => key !== "run");

  return (
    <div className="space-y-2">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">Child run</span>
      <div className="flex items-center gap-2 flex-wrap">
        {childRun && <StatusBadge status={childRun.status} />}
        {childWorkflow && (
          <Link
            to={`/workflows/${childWorkflow.id}`}
            className="text-xs hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {childWorkflow.name}
          </Link>
        )}
        <Link
          to={`/workflow-runs/${runId}`}
          className="text-primary hover:underline font-mono text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          &rarr; run {runId.slice(0, 8)}
        </Link>
      </div>

      {output.error && (
        <p className="text-xs text-status-error-strong">Partial failure: {output.error}</p>
      )}

      {results.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Node results ({results.length})
          </span>
          {results.map(([nodeId, value]) => {
            const childNode = nodes?.find((n) => n.id === nodeId);
            const childStep = childSteps.get(nodeId);
            return (
              <div key={nodeId} className="rounded-md border border-border/50 px-3 py-2 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium">{childNode?.label || nodeId}</span>
                  {childNode && (
                    <Badge variant="outline" size="tag">
                      {childNode.type}
                    </Badge>
                  )}
                  {childStep && <StatusBadge status={childStep.status} className="ml-auto" />}
                </div>
                <CollapsibleOutput label="result" data={value} />
              </div>
            );
          })}
        </div>
      )}

      <RawJsonToggle data={output} />
    </div>
  );
}

// --- Foreach attempt history ---

/**
 * A foreach item's earlier attempts behind a disclosure, oldest first: each with its status,
 * error, finished time and the same task or child-run output as the latest attempt.
 */
export function AttemptHistory({
  attempts,
  node,
  defaultOpen = false,
}: {
  attempts: WorkflowRunStep[];
  node?: WorkflowNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="flex items-center gap-1 text-xs text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Earlier attempts ({attempts.length})
      </button>
      {open && (
        <div className="space-y-1.5">
          {attempts.map((attempt, i) => (
            <div
              key={attempt.id}
              className="rounded-md border border-border/50 px-3 py-2 space-y-2"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium">attempt {i + 1}</span>
                <StatusBadge status={effectiveChildStatus(attempt)} />
                {attempt.finishedAt && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatSmartTime(attempt.finishedAt)}
                  </span>
                )}
              </div>
              {attempt.error && (
                <Alert variant="destructive" className="py-2">
                  <AlertCircle className="h-3.5 w-3.5" />
                  <AlertDescription className="text-xs font-mono whitespace-pre-wrap">
                    {attempt.error}
                  </AlertDescription>
                </Alert>
              )}
              <StepOutput step={attempt} node={node} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Agent Info ---

function AgentInfo({ node }: { node?: WorkflowNode }) {
  const agentId =
    node?.config && typeof node.config.agentId === "string" ? node.config.agentId : null;
  if (!agentId) return null;

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Agent:</span>
      <AgentLink agentId={agentId} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}

// --- HITL Config (title & questions) ---

function HitlConfig({ node }: { node: WorkflowNode }) {
  const title = typeof node.config.title === "string" ? node.config.title : null;
  const questions = Array.isArray(node.config.questions)
    ? (node.config.questions as Array<{
        id?: string;
        type?: string;
        label?: string;
        description?: string;
        options?: string[];
      }>)
    : null;

  if (!title && !questions?.length) return null;

  return (
    <div className="space-y-2">
      {title && (
        <div className="space-y-1">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Approval Title
          </span>
          <p className="text-xs text-foreground leading-relaxed rounded-md bg-muted px-3 py-2">
            {title}
          </p>
        </div>
      )}
      {questions && questions.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Questions ({questions.length})
          </span>
          <div className="space-y-1.5">
            {questions.map((q, i) => (
              <div
                key={q.id ?? i}
                className="rounded-md border border-border/50 px-3 py-2 space-y-1"
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" size="tag" className="shrink-0">
                    {q.type ?? "unknown"}
                  </Badge>
                  <span className="text-xs font-medium">
                    {q.label ?? q.id ?? `Question ${i + 1}`}
                  </span>
                </div>
                {q.description && (
                  <p className="text-[10px] text-muted-foreground">{q.description}</p>
                )}
                {q.options && q.options.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-0.5">
                    {q.options.map((opt) => (
                      <Badge
                        key={opt}
                        variant="outline"
                        className="text-[8px] px-1 py-0 h-4 font-normal leading-none items-center text-muted-foreground"
                      >
                        {opt}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Pretty-print notify node config. */
function NotifyConfig({ node }: { node: WorkflowNode }) {
  const channel = typeof node.config.channel === "string" ? node.config.channel : null;
  const message = typeof node.config.message === "string" ? node.config.message : null;
  const target = typeof node.config.target === "string" ? node.config.target : null;

  if (!channel && !message) return null;

  return (
    <div className="space-y-2">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
        Notification
      </span>
      <div className="rounded-md border border-border/50 p-2 space-y-1.5">
        {channel && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Channel:</span>
            <Badge variant="outline" size="tag">
              {channel}
            </Badge>
            {target && <span className="font-mono text-muted-foreground">{target}</span>}
          </div>
        )}
        {message && <HighlightedTemplate text={message} />}
      </div>
    </div>
  );
}

/** Highlight {{interpolation}} tokens in a template string (inline in step-card). */
function HighlightedTemplate({ text }: { text: string }) {
  const parts = text.split(/({{[^}]*}})/g);
  return (
    <p className="text-xs leading-relaxed rounded-md bg-muted px-3 py-2 font-mono whitespace-pre-wrap">
      {parts.map((part, i) =>
        /^{{[^}]*}}$/.test(part) ? (
          <span key={i} className="text-status-active-strong">
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </p>
  );
}

// --- Collapsible Output (collapsed by default, shows byte size) ---

function CollapsibleOutput({ label, data }: { label: string; data: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const size = formatBytes(jsonByteSize(data));

  return (
    <div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((prev) => !prev);
        }}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>
          {expanded ? "Hide" : "Show"} {label} ({size})
        </span>
      </button>
      {expanded && (
        <div className="mt-1">
          {typeof data === "string" ? (
            <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed rounded-md bg-muted p-3 text-muted-foreground max-h-[300px] overflow-y-auto">
              {data}
            </pre>
          ) : (
            <JsonTree data={data} defaultExpandDepth={1} maxHeight="200px" />
          )}
        </div>
      )}
    </div>
  );
}

// --- Raw JSON Toggle ---

function RawJsonToggle({ data }: { data: unknown }) {
  const [showRaw, setShowRaw] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setShowRaw((prev) => !prev);
        }}
        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      >
        <Code2 className="h-3 w-3" />
        <span>{showRaw ? "Hide" : "Show"} raw JSON</span>
      </button>
      {showRaw && (
        <pre className="mt-1 whitespace-pre-wrap text-xs font-mono leading-relaxed rounded-md bg-muted p-3 text-muted-foreground max-h-[300px] overflow-y-auto">
          {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
        </pre>
      )}
    </div>
  );
}

// --- Small helpers ---

function MetaField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
      <p className={cn("text-xs", mono && "font-mono")}>{value}</p>
    </div>
  );
}
