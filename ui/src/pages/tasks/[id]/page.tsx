import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Ban,
  Box,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cpu,
  DollarSign,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Github,
  Gitlab,
  GitPullRequest,
  Hash,
  Key,
  Link2,
  Pause,
  Play,
  Scissors,
  Tag,
  Terminal,
  Timer,
  User,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import "streamdown/styles.css";
import { useAgents } from "@/api/hooks/use-agents";
import { useSessionCosts } from "@/api/hooks/use-costs";
import {
  useCancelTask,
  usePauseTask,
  useResumeTask,
  useTask,
  useTaskContext,
  useTaskSessionLogs,
} from "@/api/hooks/use-tasks";
import { useUsers } from "@/api/hooks/use-users";
import type {
  AgentLog,
  DevinProviderMeta,
  ProviderName,
  SessionCost,
  TaskContextResponse,
} from "@/api/types";
import { AgentLink } from "@/components/shared/agent-link";
import { CollapsibleDescription } from "@/components/shared/collapsible-description";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { CostSourceBadge } from "@/components/shared/cost-source-badge";
import { MarkdownView } from "@/components/shared/markdown-view";
import { SessionId } from "@/components/shared/session-id";
import { SessionLogViewer } from "@/components/shared/session-log-viewer";
import { StatusBadge } from "@/components/shared/status-badge";
import { TaskAttachmentsSection } from "@/components/shared/task-attachments-section";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailPageSection } from "@/components/ui/detail-page-layout";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCost } from "@/lib/cost-format";
import { formatDurationMs } from "@/lib/format-duration-ms";
import { formatTokens } from "@/lib/format-tokens";
import { progressBarTone } from "@/lib/percent-progress-tone";
import { statusTextClass } from "@/lib/status-tone";
import { taskIsRunning } from "@/lib/task-activity";
import { cn, formatRelativeTime, formatSmartTime } from "@/lib/utils";

function logDotColor(eventType: string, newValue?: string): string {
  if (eventType === "task_status_change") {
    switch (newValue) {
      case "completed":
        return "bg-status-success";
      case "failed":
      case "cancelled":
        return "bg-status-error";
      case "in_progress":
        return "bg-status-active";
      default:
        return "bg-primary/60";
    }
  }
  if (eventType === "task_created") return "bg-status-paused";
  if (eventType === "task_progress") return "bg-muted-foreground/40";
  return "bg-primary/60";
}

function renderLogContent(log: AgentLog): React.ReactNode {
  switch (log.eventType) {
    case "task_created":
      return <span className="text-xs font-medium">Task created</span>;
    case "task_status_change":
      return (
        <span className="text-xs">
          {log.oldValue && (
            <span className={cn("font-medium", statusTextClass(log.oldValue))}>{log.oldValue}</span>
          )}
          {log.oldValue && <span className="text-muted-foreground"> → </span>}
          <span className={cn("font-semibold", statusTextClass(log.newValue))}>{log.newValue}</span>
        </span>
      );
    case "task_progress":
      return (
        <p className="text-xs text-muted-foreground italic line-clamp-2">
          {log.newValue ?? "Progress update"}
        </p>
      );
    case "task_offered":
      return <span className="text-xs font-medium">Offered to agent</span>;
    case "task_accepted":
      return <span className="text-xs font-medium text-status-success">Accepted</span>;
    case "task_rejected":
      return <span className="text-xs font-medium text-status-error">Rejected</span>;
    case "task_claimed":
      return <span className="text-xs font-medium text-status-success">Claimed</span>;
    case "task_released":
      return <span className="text-xs font-medium">Released</span>;
    default:
      return (
        <>
          <span className="text-xs font-medium">{log.eventType.replace(/_/g, " ")}</span>
          {log.newValue && <p className="text-xs text-muted-foreground truncate">{log.newValue}</p>}
        </>
      );
  }
}

function LogTimeline({ logs }: { logs: AgentLog[] }) {
  return (
    <div className="space-y-0">
      {logs.map((log, i) => (
        <div key={log.id} className="flex gap-3 text-sm">
          {/* Rail column — vertical 1px line connecting status-colored dots; mirrors brand-kit `.tl-rail` (preview/task-detail.html). */}
          <div className="flex flex-col items-center">
            <div
              className={cn(
                "h-2 w-2 rounded-full mt-[5px] shrink-0",
                logDotColor(log.eventType, log.newValue ?? undefined),
              )}
            />
            {i < logs.length - 1 && <div className="flex-1 w-px bg-border mt-[2px]" />}
          </div>
          <div className="pb-3 min-w-0">
            {renderLogContent(log)}
            <p className="text-[10px] text-muted-foreground/60 mt-0.5">
              {formatRelativeTime(log.createdAt)}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

function MetaRow({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <div className="flex items-center gap-2 w-24 shrink-0">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="text-sm min-w-0">{children}</div>
    </div>
  );
}

/** Try to parse structured output JSON ({status, output, summary}). */
function parseStructuredOutput(raw: string): { output?: string; summary?: string } | null {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      ("output" in parsed || "summary" in parsed)
    )
      return parsed as { output?: string; summary?: string };
  } catch {
    // Not JSON — fall through.
  }
  return null;
}

function StructuredOutputContent({ raw, maxH }: { raw: string; maxH: string }) {
  const structured = parseStructuredOutput(raw);
  if (!structured) {
    return (
      <div className={`text-sm leading-relaxed overflow-auto text-foreground/80 ${maxH}`}>
        <MarkdownView text={raw} />
      </div>
    );
  }
  return (
    <div className={`space-y-3 overflow-auto ${maxH}`}>
      {structured.summary && (
        <div>
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Summary
          </span>
          <div className="mt-1 text-sm leading-relaxed text-foreground/80">
            <MarkdownView text={structured.summary} />
          </div>
        </div>
      )}
      {structured.output && (
        <div>
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Output
          </span>
          <div className="mt-1 text-sm leading-relaxed text-foreground/80">
            <MarkdownView text={structured.output} />
          </div>
        </div>
      )}
    </div>
  );
}

function TaskCostSection({
  costs,
  isLoading,
  provider,
  providerMeta,
}: {
  costs: SessionCost[] | undefined;
  isLoading: boolean;
  provider?: ProviderName;
  providerMeta?: DevinProviderMeta | Record<string, never>;
}) {
  const isDevin = provider === "devin";
  const devinMeta = isDevin ? (providerMeta as DevinProviderMeta | undefined) : undefined;

  const stats = useMemo(() => {
    if (!costs || costs.length === 0) return null;
    const totalCost = costs.reduce((sum, c) => sum + c.totalCostUsd, 0);
    const inputTokens = costs.reduce((sum, c) => sum + c.inputTokens, 0);
    const outputTokens = costs.reduce((sum, c) => sum + c.outputTokens, 0);
    const cacheReadTokens = costs.reduce((sum, c) => sum + c.cacheReadTokens, 0);
    const cacheWriteTokens = costs.reduce((sum, c) => sum + (c.cacheWriteTokens ?? 0), 0);
    const totalDurationMs = costs.reduce((sum, c) => sum + c.durationMs, 0);
    const totalTurns = costs.reduce((sum, c) => sum + (c.numTurns ?? 0), 0);
    const models = [...new Set(costs.map((c) => c.model))];
    // Phase 12b — collapse the per-row costSource into a single badge for
    // the aggregate. If every row agrees, show that. If they differ, show
    // 'harness' (the weakest claim) so we don't over-state precision.
    const sources = new Set(costs.map((c) => c.costSource));
    const aggregateCostSource = sources.size === 1 ? Array.from(sources)[0] : ("harness" as const);
    return {
      totalCost,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalDurationMs,
      totalTurns,
      models,
      sessions: costs.length,
      costSource: aggregateCostSource,
    };
  }, [costs]);

  if (isLoading) {
    return (
      <DetailPageSection title="Session Cost">
        <div className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3 w-24" />
        </div>
      </DetailPageSection>
    );
  }

  if (!stats) return null;

  const acuCostUsd = devinMeta?.acuCostUsd ?? 2.25;
  const acusConsumed = isDevin ? stats.totalCost / acuCostUsd : 0;

  return (
    <DetailPageSection title="Session Cost">
      <div className="space-y-1">
        <MetaRow icon={DollarSign} label="Cost">
          <span className="text-xs font-semibold inline-flex items-center gap-1.5">
            {formatCost(stats.totalCost, { precision: 4 })}
            <CostSourceBadge source={stats.costSource} />
          </span>
        </MetaRow>
        {isDevin ? (
          <MetaRow icon={Zap} label="ACUs">
            <span className="text-xs font-mono">{acusConsumed.toFixed(2)}</span>
          </MetaRow>
        ) : (
          <>
            <MetaRow icon={Zap} label="Tokens">
              <span className="text-xs font-mono">
                {formatTokens(stats.inputTokens)} in / {formatTokens(stats.outputTokens)} out
              </span>
            </MetaRow>
            {(stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0) && (
              <MetaRow icon={Zap} label="Cache">
                <span className="text-xs font-mono">
                  {formatTokens(stats.cacheReadTokens)} read /{" "}
                  {formatTokens(stats.cacheWriteTokens)} write
                </span>
              </MetaRow>
            )}
          </>
        )}
        <MetaRow icon={Timer} label="Duration">
          <span className="text-xs">{formatDurationMs(stats.totalDurationMs)}</span>
        </MetaRow>
        {!isDevin && (
          <MetaRow icon={Hash} label="Turns">
            <span className="text-xs">
              {stats.totalTurns.toLocaleString()}
              {stats.sessions > 1 ? ` (${stats.sessions} sessions)` : ""}
            </span>
          </MetaRow>
        )}
        <MetaRow icon={Cpu} label="Model">
          <span className="text-xs font-mono">{stats.models.join(", ")}</span>
        </MetaRow>
      </div>
    </DetailPageSection>
  );
}

function TaskContextSection({
  context,
  isLoading,
  provider,
  providerMeta,
  costs,
}: {
  context: TaskContextResponse | undefined;
  isLoading: boolean;
  provider?: ProviderName;
  providerMeta?: DevinProviderMeta | Record<string, never>;
  costs?: SessionCost[];
}) {
  const isDevin = provider === "devin";
  const devinMeta = isDevin ? (providerMeta as DevinProviderMeta | undefined) : undefined;

  if (isDevin) {
    const maxAcuLimit = devinMeta?.maxAcuLimit;
    const acuCostUsd = devinMeta?.acuCostUsd ?? 2.25;
    const totalCost = costs?.reduce((sum, c) => sum + c.totalCostUsd, 0) ?? 0;
    const acusConsumed = totalCost / acuCostUsd;

    if (!maxAcuLimit) return null;

    const percent = Math.min((acusConsumed / maxAcuLimit) * 100, 100);

    return (
      <>
        <Separator className="my-2" />
        <div className="space-y-1">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            ACU Budget
          </span>
          <div className="flex items-center gap-2 py-1">
            <Progress value={percent} className={cn("h-1.5 flex-1", progressBarTone(percent))} />
            <span className="text-[10px] font-mono text-muted-foreground shrink-0">
              {percent.toFixed(0)}%
            </span>
          </div>
          <MetaRow icon={Zap} label="Used">
            <span className="text-xs font-mono">
              {acusConsumed.toFixed(2)} / {maxAcuLimit} ACUs
            </span>
          </MetaRow>
        </div>
      </>
    );
  }

  if (isLoading) {
    return (
      <>
        <Separator className="my-2" />
        <div className="space-y-1.5">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Context Usage
          </span>
          <div className="space-y-2">
            <Skeleton className="h-2 w-full rounded-full" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      </>
    );
  }

  if (!context || context.summary.snapshotCount === 0) return null;

  const { summary } = context;
  const latestSnapshot = context.snapshots[context.snapshots.length - 1];
  const currentPercent = latestSnapshot?.contextPercent ?? summary.peakContextPercent ?? 0;
  const usedTokens = latestSnapshot?.contextUsedTokens ?? summary.peakContextTokens ?? 0;
  const totalTokens = latestSnapshot?.contextTotalTokens ?? summary.contextWindowSize ?? 0;

  return (
    <>
      <Separator className="my-2" />
      <div className="space-y-1">
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          Context Usage
        </span>
        <div className="flex items-center gap-2 py-1">
          <Progress
            value={currentPercent}
            className={cn("h-1.5 flex-1", progressBarTone(currentPercent))}
          />
          <span className="text-[10px] font-mono text-muted-foreground shrink-0">
            {currentPercent.toFixed(0)}%
          </span>
        </div>
        <MetaRow icon={Cpu} label="Used">
          <span className="flex flex-col items-start gap-1 font-mono text-xs">
            <span className="whitespace-nowrap">
              {formatTokens(usedTokens)} / {formatTokens(totalTokens)}
            </span>
            {latestSnapshot?.contextFormula && latestSnapshot.contextFormula !== "unknown" && (
              <Badge
                variant="outline"
                size="tag"
                className="text-muted-foreground"
                title={`Computed via formula: ${latestSnapshot.contextFormula}`}
              >
                {latestSnapshot.contextFormula}
              </Badge>
            )}
          </span>
        </MetaRow>
        {summary.peakContextPercent != null && (
          <MetaRow icon={Activity} label="Peak">
            <span className="text-xs font-mono">{summary.peakContextPercent.toFixed(0)}%</span>
          </MetaRow>
        )}
        {summary.compactionCount > 0 && (
          <MetaRow icon={Scissors} label="Compactions">
            <span className="text-xs font-mono">{summary.compactionCount}</span>
          </MetaRow>
        )}
      </div>
    </>
  );
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading } = useTask(id!);
  const { data: sessionLogs } = useTaskSessionLogs(id!);
  const { data: agents } = useAgents();
  const { data: users } = useUsers();
  const { data: costs, isLoading: costsLoading } = useSessionCosts({ taskId: id });
  const { data: contextData, isLoading: contextLoading } = useTaskContext(id!);
  const cancelTask = useCancelTask();
  const pauseTask = usePauseTask();
  const resumeTask = useResumeTask();
  const agentName = useMemo(() => {
    if (!task?.agentId || !agents) return null;
    return agents.find((a) => a.id === task.agentId)?.name ?? null;
  }, [task, agents]);
  // Phase 3: read-only "Requested by" lookup. `useUsers()` is shared cache —
  // the identity boot modal already populated it.
  const requestedByUserName = useMemo(() => {
    if (!task?.requestedByUserId || !users) return null;
    return users.find((u) => u.id === task.requestedByUserId)?.name ?? null;
  }, [task, users]);

  // Phase 17 — collapsible right rail (Activity feed). Persists to
  // localStorage so the choice survives reloads and route changes.
  const [railCollapsed, setRailCollapsed] = useState(() => {
    if (typeof window === "undefined") return true;
    // Collapsed by default on first visit; respect a stored preference thereafter.
    const stored = window.localStorage.getItem("agent-swarm-task-rail-collapsed-v2");
    return stored === null ? true : stored === "1";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("agent-swarm-task-rail-collapsed-v2", railCollapsed ? "1" : "0");
  }, [railCollapsed]);

  if (isLoading) {
    return (
      <div className="flex-1 min-h-0 space-y-4 p-1">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!task) {
    return <p className="text-muted-foreground">Task not found.</p>;
  }

  const terminalStatuses = ["completed", "failed", "cancelled"];
  const canCancel = !terminalStatuses.includes(task.status) && task.status !== "paused";
  const canPause = task.status === "in_progress";
  const canResume = task.status === "paused";

  const isFailed = task.status === "failed";
  const isCompleted = task.status === "completed";
  const hasSessionLogs = sessionLogs && sessionLogs.length > 0;
  const hasOutput = !!task.output;
  const hasEvents = task.logs && task.logs.length > 0;
  const hasAttachments = !!(task.attachments && task.attachments.length > 0);

  // LEFT RAIL — meta info + SCM card + Dependencies + Progress + Context budget +
  // Session Cost. Mirrors brand-kit `preview/task-detail.html` left column
  // (meta-row + .scm-card + .csec-deps + .csec-ctx). Phase 17 moved Session Cost
  // here from the right rail so the user sees cost stats without scrolling the
  // Activity feed; right rail now hosts only the Activity timeline.
  const leftRailContent = (
    <div className="space-y-1">
      {task.agentId && (
        <MetaRow icon={User} label="Agent">
          <Link to={`/agents/${task.agentId}`} className="text-primary hover:underline text-xs">
            {agentName ?? `${task.agentId.slice(0, 8)}...`}
          </Link>
        </MetaRow>
      )}
      {task.creatorAgentId && task.creatorAgentId !== task.agentId && (
        <MetaRow icon={User} label="Created by">
          <AgentLink agentId={task.creatorAgentId} />
        </MetaRow>
      )}
      {task.requestedByUserId && (
        <MetaRow icon={User} label="Requested by">
          <span className="text-xs">
            {requestedByUserName ?? `${task.requestedByUserId.slice(0, 8)}…`}
          </span>
        </MetaRow>
      )}
      <MetaRow icon={Calendar} label="Created">
        <span className="text-xs">{formatSmartTime(task.createdAt)}</span>
      </MetaRow>
      {task.finishedAt && (
        <MetaRow icon={Clock} label="Finished">
          <span className="text-xs">{formatSmartTime(task.finishedAt)}</span>
        </MetaRow>
      )}
      {task.swarmVersion && (
        <MetaRow icon={Tag} label="Swarm version">
          <span
            className="text-xs font-mono text-muted-foreground"
            title={`agent-swarm ${task.swarmVersion} at task creation`}
          >
            v{task.swarmVersion}
          </span>
        </MetaRow>
      )}
      {task.parentTaskId && (
        <MetaRow icon={Link2} label="Parent">
          <Link
            to={`/tasks/${task.parentTaskId}`}
            className="text-primary hover:underline font-mono text-xs"
          >
            #{task.parentTaskId.slice(0, 8)}
          </Link>
        </MetaRow>
      )}
      {task.dir && (
        <MetaRow icon={FolderOpen} label="Dir">
          <span className="text-xs font-mono truncate" title={task.dir}>
            {task.dir}
          </span>
        </MetaRow>
      )}
      {task.claudeSessionId && (
        <MetaRow icon={Terminal} label="Session">
          <SessionId
            sessionId={task.claudeSessionId}
            provider={task.provider}
            providerMeta={task.providerMeta}
          />
        </MetaRow>
      )}
      {task.credentialKeySuffix && (
        <MetaRow icon={Key} label="API Key">
          <Link to="/settings/api-keys" className="text-primary hover:underline font-mono text-xs">
            {task.credentialKeyType === "CLAUDE_CODE_OAUTH_TOKEN"
              ? "OAuth"
              : task.credentialKeyType === "ANTHROPIC_API_KEY"
                ? "Anthropic"
                : task.credentialKeyType === "OPENROUTER_API_KEY"
                  ? "OpenRouter"
                  : (task.credentialKeyType ?? "Key")}{" "}
            ...{task.credentialKeySuffix}
          </Link>
        </MetaRow>
      )}
      {task.workflowRunId && (
        <MetaRow icon={Box} label="Workflow">
          <Link
            to={`/workflow-runs/${task.workflowRunId}`}
            className="text-primary hover:underline font-mono text-xs"
          >
            #{task.workflowRunId.slice(0, 8)}
          </Link>
        </MetaRow>
      )}

      {(task.vcsProvider || task.vcsRepo || task.vcsUrl || task.vcsEventType || task.vcsAuthor) && (
        <>
          <Separator className="my-2" />
          <div className="space-y-1.5">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Source Control
            </span>
            <div className="rounded-md border border-border/50 px-3 py-2.5 space-y-2">
              {/* Row 1: Provider icon + repo name */}
              <div className="flex items-center gap-2">
                {task.vcsProvider === "github" ? (
                  <Github className="h-4 w-4 shrink-0" />
                ) : task.vcsProvider === "gitlab" ? (
                  <Gitlab className="h-4 w-4 shrink-0" />
                ) : task.vcsProvider ? (
                  <Link2 className="h-4 w-4 shrink-0" />
                ) : null}
                {task.vcsRepo && (
                  <span className="text-xs font-mono text-foreground whitespace-nowrap truncate">
                    {task.vcsRepo}
                  </span>
                )}
                {task.vcsAuthor && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1 ml-auto">
                    <User className="h-3 w-3" />
                    {task.vcsAuthor}
                  </span>
                )}
              </div>
              {/* Row 2: PR/MR link */}
              {task.vcsUrl && task.vcsNumber && (
                <a
                  href={task.vcsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                >
                  <GitPullRequest className="h-3.5 w-3.5 shrink-0" />
                  <span className="font-mono">#{task.vcsNumber}</span>
                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                </a>
              )}
              {task.vcsUrl && !task.vcsNumber && (
                <a
                  href={task.vcsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline font-mono truncate"
                >
                  <Link2 className="h-3.5 w-3.5 shrink-0" />
                  {task.vcsUrl}
                  <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                </a>
              )}
            </div>
          </div>
        </>
      )}

      {task.dependsOn && task.dependsOn.length > 0 && (
        <>
          <Separator className="my-2" />
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <GitBranch className="h-3 w-3 text-muted-foreground" />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Dependencies ({task.dependsOn.length})
              </span>
            </div>
            {task.dependsOn.map((depId) => (
              <Link
                key={depId}
                to={`/tasks/${depId}`}
                className="flex items-center gap-1.5 text-xs text-primary hover:underline font-mono"
              >
                #{depId.slice(0, 8)}
              </Link>
            ))}
          </div>
        </>
      )}

      {task.progress && (
        <>
          <Separator className="my-2" />
          <div className="space-y-1">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Progress
            </span>
            <p className="text-xs text-muted-foreground whitespace-pre-wrap leading-relaxed max-h-32 overflow-auto">
              {task.progress}
            </p>
          </div>
        </>
      )}

      <TaskContextSection
        context={contextData}
        isLoading={contextLoading}
        provider={task.provider}
        providerMeta={task.providerMeta}
        costs={costs}
      />

      {/* Phase 17 — Session Cost moved from right rail to left rail. The right
          rail now hosts only the Activity timeline (which gets a sticky header
          + scrollable body), while cost stats live alongside the other static
          meta rows on the left so the user sees them without scrolling the
          activity feed. */}
      <TaskCostSection
        costs={costs}
        isLoading={costsLoading}
        provider={task.provider}
        providerMeta={task.providerMeta}
      />
    </div>
  );

  // RIGHT RAIL — Activity timeline only (Phase 17 moved Session Cost to the
  // left rail). Phase 18 — restructured the sticky-heading pattern:
  //
  // The aside is the scroll container (overflow-y-auto). The Activity heading
  // is a `position: sticky top-0` direct child of a bare wrapper div (no
  // <DetailPageRail>/<section> in between). Two changes from Phase 17 fix the
  // coverage bug where timeline rows showed above the pinned heading:
  //
  //   1. Removed the `<DetailPageRail>` (`flex flex-col`) and `<section>`
  //      wrappers around the sticky h4. Sticky inside `flex` items can mis-
  //      pin in some scroll-with-padding configurations; the bare div gives
  //      the h4 an unambiguous block-flow containing block whose bounds match
  //      the aside content area exactly.
  //   2. The aside's vertical padding (`py-3`) was moved off the top — the
  //      h4 owns its own `pt-3 pb-3` padding instead, with `-mx-3` extending
  //      its bg-background to the aside edges. This removes the transparent
  //      `mb-2.5` gap between heading and timeline that previously let rows
  //      scroll into view immediately under the heading. `pr-10` reserves
  //      room for the collapse chevron.
  //
  // bg-background is the rail's actual surface (no `bg-card` on the aside —
  // it inherits from the page <body>'s background, which is bg-background).
  // z-30 keeps the heading above both the timeline rows (no z) and the
  // chevron toggle (z-20), so the heading visually covers everything that
  // scrolls past it.
  const rightRailContent = hasEvents ? (
    <div>
      <h4 className="sticky top-0 z-30 bg-background -mx-3 px-3 pt-3 pb-3 pr-10 font-mono font-bold text-[10px] uppercase tracking-[0.08em] text-muted-foreground border-b border-border">
        <Activity className="h-3 w-3 inline-block mr-1 -mt-0.5 text-muted-foreground" />
        Activity ({task.logs!.length})
      </h4>
      <div className="pt-3">
        <LogTimeline logs={task.logs!} />
      </div>
    </div>
  ) : null;

  const outcomeContent = (
    <div className="space-y-2">
      {isFailed && task.failureReason && (
        <CollapsibleSection
          variant="card"
          title="Failure Reason"
          icon={AlertTriangle}
          iconColor="text-status-error"
          borderColor="border-status-error/30"
          bgColor="bg-status-error/5"
          defaultOpen
        >
          <div className="text-sm text-status-error/80 leading-relaxed max-h-64 overflow-auto">
            <MarkdownView text={task.failureReason ?? ""} />
          </div>
        </CollapsibleSection>
      )}

      {hasOutput && (
        <CollapsibleSection
          variant="card"
          title="Output"
          icon={isCompleted ? CheckCircle2 : Terminal}
          iconColor={isCompleted ? "text-status-success" : "text-muted-foreground"}
          borderColor={isCompleted ? "border-status-success/30" : "border-border"}
          bgColor={isCompleted ? "bg-status-success/5" : "bg-muted/20"}
          defaultOpen
        >
          <StructuredOutputContent raw={task.output ?? ""} maxH="max-h-[60vh]" />
        </CollapsibleSection>
      )}

      <TaskAttachmentsSection attachments={task.attachments} />

      {!isFailed && !hasOutput && !hasAttachments && (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <p className="text-xs">No output available</p>
        </div>
      )}
    </div>
  );

  const sessionLogsContent = hasSessionLogs ? (
    <SessionLogViewer
      logs={sessionLogs}
      compactionSnapshots={contextData?.snapshots}
      isRunning={taskIsRunning(task.status)}
      className="flex-1 min-h-0"
    />
  ) : (
    <div className="flex-1 flex items-center justify-center min-h-0">
      <div className="text-center text-muted-foreground">
        <Terminal className="h-8 w-8 mx-auto mb-2 opacity-30" />
        <p className="text-xs">No session data available</p>
      </div>
    </div>
  );

  // HERO — status badge + tags / priority / source / provider / model badges +
  // collapsible description + action buttons. Rendered inside the center column
  // on desktop (lg+) and above the Tabs on mobile/tablet (<lg). Same JSX in both
  // places — single-use; not extractable per the "appears in 2+ places" rule.
  const heroBlock = (
    // Phase 17 — generous padding around the badges/description/actions block
    // ("the task details part on top of the logs"). Brand kit's
    // `preview/task-detail.html` `.header { padding: 14px 18px 12px }` informs
    // the new px-4/py-4 values; the `space-y-3` opens up vertical breathing
    // between badge row → description → action row.
    <div className="space-y-3 px-4 pt-4 pb-5 shrink-0">
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={task.status} size="md" />
        {task.taskType && (
          <Badge variant="outline" size="tag">
            {task.taskType}
          </Badge>
        )}
        {task.priority !== undefined && (
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-mono leading-none items-center"
          >
            P{task.priority}
          </Badge>
        )}
        {task.tags?.map((tag) => (
          <Badge key={tag} variant="outline" size="tag">
            {tag}
          </Badge>
        ))}
        {task.source && (
          <Badge variant="outline" size="tag">
            {task.source}
          </Badge>
        )}
        {task.provider && (
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
          >
            {task.provider}
            {task.harnessVariant && (
              <span className="opacity-60">
                {" · "}
                {task.harnessVariant === "bridge"
                  ? `bridge${task.harnessVariantMeta?.version ? ` ${task.harnessVariantMeta.version}` : ""}`
                  : "stock"}
              </span>
            )}
          </Badge>
        )}
        {(() => {
          // Prefer the model recorded on the task row (set at task creation
          // when explicitly requested), but fall back to whatever the
          // session_costs entries report — codex tasks don't carry a
          // task-level model today, so the cost record is the source of
          // truth for what was actually used.
          const displayModel = task.model ?? costs?.[0]?.model;
          return displayModel ? (
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 h-5 font-mono leading-none items-center"
            >
              {displayModel}
            </Badge>
          ) : null;
        })()}
      </div>
      <CollapsibleDescription text={task.task} />
      <div className="flex items-center gap-2">
        {(canCancel || canPause || canResume) && (
          <div className="flex items-center gap-1.5 shrink-0">
            {canPause && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => pauseTask.mutate(task.id)}
                disabled={pauseTask.isPending}
              >
                <Pause className="h-3 w-3 mr-1" />
                Pause
              </Button>
            )}
            {canResume && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => resumeTask.mutate(task.id)}
                disabled={resumeTask.isPending}
              >
                <Play className="h-3 w-3 mr-1" />
                Resume
              </Button>
            )}
            {canCancel && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive-outline" size="sm">
                    <Ban className="h-3 w-3 mr-1" />
                    Cancel
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Cancel Task</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to cancel this task? This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep Task</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() =>
                        cancelTask.mutate({ id: task.id, reason: "Cancelled from dashboard" })
                      }
                    >
                      Cancel Task
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Breadcrumb — fixed at top across all breakpoints */}
      <div className="px-1 pb-2 shrink-0">
        <button
          type="button"
          onClick={() => navigate("/tasks")}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3 w-3" /> Back to Tasks
        </button>
      </div>

      {/* Mobile / tablet (<lg): hero above tabs. Tabs hold left-rail meta in
          Details (with right-rail Activity + Cost merged in so nothing is lost),
          Outcome card, and Session Logs. Below lg the 3-column grid does not
          fit; we fall back to the previous tabbed layout, extended to include
          the right-rail content. */}
      <div className="lg:hidden flex flex-col flex-1 min-h-0">
        {heroBlock}
        <Separator className="shrink-0" />
        <Tabs defaultValue="details" className="flex flex-col flex-1 min-h-0">
          <TabsList className="shrink-0 mx-1 mt-2">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="outcome">Outcome</TabsTrigger>
            <TabsTrigger value="logs">Session Logs</TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="flex-1 overflow-y-auto px-1 py-3 space-y-4">
            {leftRailContent}
            {rightRailContent}
          </TabsContent>
          <TabsContent value="outcome" className="flex-1 overflow-y-auto px-1 py-3">
            {outcomeContent}
          </TabsContent>
          <TabsContent value="logs" className="flex flex-col flex-1 min-h-0 px-1 py-3">
            {sessionLogsContent}
          </TabsContent>
        </Tabs>
      </div>

      {/* Desktop (lg+): 3-column meta-rail layout per
          ~/Downloads/swarm-design-system/preview/task-detail.html and
          preview/detail-page-template.html. Both rails at 280px (canonical
          brand-kit width). The left meta-sidebar remains page-specific (no
          other detail page has dense meta data); the right rail comes from
          the <DetailPageBody> contract. Phase 17 — the right rail collapses
          to a 36px gutter (just the toggle button) so the center column can
          take the freed width. State persists in localStorage. */}
      <div
        className={cn(
          "hidden lg:grid flex-1 min-h-0 overflow-hidden",
          railCollapsed ? "lg:grid-cols-[280px_1fr_36px]" : "lg:grid-cols-[280px_1fr_280px]",
        )}
      >
        {/* Left rail — meta info + SCM card + Dependencies + Progress + Context budget + Session Cost */}
        <aside className="border-r border-border py-3 px-1 pr-3 overflow-y-auto min-h-0">
          {leftRailContent}
        </aside>

        {/* Center — hero (badges + description + actions) + Failure / Output cards + SessionLogViewer */}
        <section className="flex flex-col min-h-0 overflow-hidden">
          {heroBlock}
          <Separator className="shrink-0" />
          {/* Phase 17 — bumped padding from py-3 px-3 gap-2 to py-4 px-4 gap-3
              to match brand-kit `.body { padding: 14px 18px }` and give the
              SessionLogViewer + Failure / Output cards more breathing room. */}
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden py-4 px-4 gap-3">
            {isFailed && task.failureReason && (
              <CollapsibleSection
                variant="card"
                title="Failure Reason"
                icon={AlertTriangle}
                iconColor="text-status-error"
                borderColor="border-status-error/30"
                bgColor="bg-status-error/5"
              >
                <div className="text-sm text-status-error/80 leading-relaxed max-h-48 overflow-auto">
                  <MarkdownView text={task.failureReason ?? ""} />
                </div>
              </CollapsibleSection>
            )}

            {hasOutput && (
              <CollapsibleSection
                variant="card"
                title="Output"
                icon={isCompleted ? CheckCircle2 : Terminal}
                iconColor={isCompleted ? "text-status-success" : "text-muted-foreground"}
                borderColor={isCompleted ? "border-status-success/30" : "border-border"}
                bgColor={isCompleted ? "bg-status-success/5" : "bg-muted/20"}
              >
                <StructuredOutputContent raw={task.output ?? ""} maxH="max-h-48" />
              </CollapsibleSection>
            )}

            <TaskAttachmentsSection attachments={task.attachments} />

            {hasSessionLogs ? (
              <SessionLogViewer
                logs={sessionLogs}
                compactionSnapshots={contextData?.snapshots}
                isRunning={taskIsRunning(task.status)}
                className="flex-1 min-h-0"
              />
            ) : (
              <div className="flex-1 flex items-center justify-center min-h-0">
                <div className="text-center text-muted-foreground">
                  <Terminal className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p className="text-xs">No session data available</p>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Right rail — Activity timeline (sticky header). Collapsible: when
            collapsed, only the toggle chevron shows; click to re-expand.
            Phase 18 — moved `py-3` off the aside (the sticky h4 now owns the
            top zone via its own `pt-3 -mx-3 px-3 bg-background`); kept `pb-3`
            so the timeline still gets bottom breathing room. */}
        <aside
          className={cn(
            "border-l border-border min-h-0 relative",
            railCollapsed ? "overflow-hidden" : "overflow-y-auto pb-3 px-3",
          )}
        >
          {/* Phase 19 — chevron must paint above the sticky Activity heading
              (z-30 from Phase 18). Bumped to z-40 so the toggle stays visible
              while the heading still covers timeline rows scrolling past it.
              The h4's `pr-10` reserves visual room for the chevron so they
              don't overlap horizontally even with the higher z-index. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setRailCollapsed((v) => !v)}
                aria-label={railCollapsed ? "Expand activity rail" : "Collapse activity rail"}
                className={cn(
                  "absolute z-40 top-2 h-6 w-6 inline-flex cursor-pointer items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:bg-accent hover:text-foreground transition-colors",
                  railCollapsed ? "left-1/2 -translate-x-1/2" : "right-2",
                )}
              >
                {railCollapsed ? (
                  <ChevronLeft className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">
              {railCollapsed ? "Activity" : "Collapse activity"}
            </TooltipContent>
          </Tooltip>
          {!railCollapsed && rightRailContent}
        </aside>
      </div>
    </div>
  );
}
