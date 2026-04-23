import {
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Code2,
  Loader2,
  Timer,
} from "lucide-react";
import { forwardRef, useState } from "react";
import { Link } from "react-router-dom";
import type { WorkflowNode, WorkflowRunStep } from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { JsonTree } from "@/components/workflows/json-tree";
import { cn, formatElapsed, formatSmartTime } from "@/lib/utils";

export interface StepCardProps {
  step: WorkflowRunStep;
  workflowNodes?: WorkflowNode[];
  isSelected: boolean;
  isExpanded: boolean;
  onClick: () => void;
  onToggleExpand: () => void;
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
  ({ step, workflowNodes, isSelected, isExpanded, onClick, onToggleExpand }, ref) => {
    const node = workflowNodes?.find((n) => n.id === step.nodeId);
    const label = node?.label || step.nodeId;
    const duration =
      step.startedAt && step.finishedAt ? formatElapsed(step.startedAt, step.finishedAt) : null;

    const diagnostics = parseDiagnostics(step.diagnostics);
    const unresolvedTokens = diagnostics?.unresolvedTokens;

    return (
      <div
        ref={ref}
        onClick={onClick}
        className={cn(
          "rounded-md border bg-background transition-colors cursor-pointer",
          isSelected && "border-l-2 border-l-amber-500",
        )}
      >
        {/* Header row - always visible */}
        <div className="w-full flex items-center gap-2 px-3 py-2">
          <span className="text-sm font-medium truncate">{label}</span>

          <Badge variant="outline" size="tag" className="shrink-0">
            {step.nodeType}
          </Badge>

          {step.nextPort && step.nextPort !== "default" && (
            <Badge variant="outline" size="tag" className="shrink-0 border-sky-500/30 text-sky-400">
              port: {step.nextPort}
            </Badge>
          )}

          <StatusBadge status={step.status} className="shrink-0" />

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
                <Badge variant="outline" size="tag" className="text-amber-600 dark:text-amber-400">
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
              <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
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
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
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

function HitlOutput({ step, node }: { step: WorkflowRunStep; node?: WorkflowNode }) {
  const output = step.output as
    | {
        requestId: string;
        status: "approved" | "rejected" | "timeout";
        responses: Record<string, unknown> | null;
      }
    | null
    | undefined;

  // Waiting state — no output yet
  if (output == null) {
    if (step.status === "waiting") {
      return (
        <div className="flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400 py-1">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
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
      ? "border-emerald-500/30 text-emerald-400"
      : output.status === "rejected"
        ? "border-red-500/30 text-red-400"
        : "border-amber-500/30 text-amber-400";
  const statusLabel =
    output.status === "approved"
      ? "Approved"
      : output.status === "rejected"
        ? "Rejected"
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
                        <span className={answer ? "text-emerald-400" : "text-red-400"}>
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
          <span key={i} className="text-amber-500">
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
