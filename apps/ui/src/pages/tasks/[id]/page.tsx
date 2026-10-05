import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Ban, CheckCircle2, Pause, Play, Terminal, Zap } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  renderTaskCitationSources,
  renderTaskCitations,
  type TaskCitation,
} from "../../../../../../src/utils/task-citations";
import "streamdown/styles.css";
import { useAgents } from "@/api/hooks/use-agents";
import { useSessionCosts } from "@/api/hooks/use-costs";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSteeringEnabled } from "@/api/hooks/use-stats";
import {
  useCancelTask,
  usePauseTask,
  useResumeTask,
  useTask,
  useTaskContext,
  useTaskSessionLogs,
  useTaskSteeringMessages,
} from "@/api/hooks/use-tasks";
import { useUsers } from "@/api/hooks/use-users";
import type { AgentLog, AgentTaskStatus } from "@/api/types";
import { CollapsibleDescription } from "@/components/shared/collapsible-description";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { MarkdownView } from "@/components/shared/markdown-view";
import { SessionLogViewer } from "@/components/shared/session-log-viewer";
import { StatusBadge } from "@/components/shared/status-badge";
import { TaskAttachmentsSection } from "@/components/shared/task-attachments-section";
import { TaskCitationsSection } from "@/components/shared/task-citations-section";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { CollapsibleComposerDock } from "@/components/steering/collapsible-composer-dock";
import { SteerComposer } from "@/components/steering/steer-composer";
import { TaskFailureHelpDialog } from "@/components/support/task-failure-help-dialog";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocalToggle } from "@/hooks/use-local-toggle";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { modelTierLabel } from "@/lib/model-tiers";
import { formatSlackMentions } from "@/lib/slack-text";
import { TERMINAL_STATUSES, taskIsRunning } from "@/lib/task-activity";
import { describeModelResolution, taskDisplayModel } from "@/lib/task-model-resolution";
import { taskListTitle } from "@/lib/task-title";
import { cn, formatRelativeTime } from "@/lib/utils";
import { TaskDetailsRail } from "./task-details-rail";
import { STICKY_BAR_HEIGHT, TaskStickyBar, useHeroScrolledPast } from "./task-sticky-bar";

const TASK_DETAIL_TABS = new Set(["details", "outcome", "logs"]);

function coerceTaskDetailTab(value: string): string {
  return TASK_DETAIL_TABS.has(value) ? value : "details";
}

/** Task title as the page heading; a long one clamps with a toggle. */
function TaskHeading({ title }: { title: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = title.length > 120;
  return (
    <div className="space-y-1">
      <h1
        className={cn(
          "text-base lg:text-lg font-semibold leading-snug text-pretty break-words",
          isLong && !expanded && "line-clamp-3 lg:line-clamp-2",
        )}
      >
        {title}
      </h1>
      {isLong ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

/** Cancel, behind a confirm step. */
function CancelTaskButton({ onConfirm }: { onConfirm: () => void }) {
  return (
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
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Cancel Task
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * What a task with no session log waits for, in one line. The hero owns the
 * actions (Cancel, Resume). `draft` is the transient "attachments still
 * uploading" state.
 */
function describeWaiting(
  task: { status: AgentTaskStatus; createdAt: string },
  names: { agent: string | null; offeredTo: string | null },
): string {
  switch (task.status) {
    case "pending":
    case "unassigned":
      return `Waiting for ${names.agent ?? "an agent"} to pick this up. Queued ${formatRelativeTime(task.createdAt)}.`;
    case "offered":
    case "reviewing":
      return `Offered to ${names.offeredTo ?? "an agent"}. Waiting for an answer.`;
    case "backlog":
      return "In the backlog.";
    case "paused":
      return "Paused.";
    case "draft":
      return "Uploading attachments…";
    case "in_progress":
      return "Waiting for the first session log.";
    default:
      return "This task finished without a session log.";
  }
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
    // Not JSON, fall through.
  }
  return null;
}

function StructuredOutputContent({
  raw,
  maxH,
  citations = [],
}: {
  raw: string;
  maxH: string;
  citations?: TaskCitation[];
}) {
  const structured = parseStructuredOutput(raw);
  if (!structured) {
    return (
      <div className={`text-sm leading-relaxed overflow-auto text-foreground/80 ${maxH}`}>
        <MarkdownView text={renderTaskCitations(raw, citations, "markdown")} />
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
            <MarkdownView
              text={renderTaskCitations(structured.summary, citations, "markdown", false)}
            />
          </div>
        </div>
      )}
      {structured.output && (
        <div>
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Output
          </span>
          <div className="mt-1 text-sm leading-relaxed text-foreground/80">
            <MarkdownView
              text={renderTaskCitations(structured.output, citations, "markdown", false)}
            />
          </div>
        </div>
      )}
      {citations.length > 0 && (
        <MarkdownView text={renderTaskCitationSources(raw, citations, "markdown")} />
      )}
    </div>
  );
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: task, isLoading } = useTask(id!);
  // A finished task's log, context and steering rows are frozen history: read
  // them once and never poll. Until the task itself loads, hold the poll too,
  // so a finished task never gets a second read. `undefined` keeps each
  // hook's live cadence.
  const taskLive = !!task && !TERMINAL_STATUSES.has(task.status);
  const livePoll = taskLive ? undefined : false;
  const { data: sessionLogs, isLoading: sessionLogsLoading } = useTaskSessionLogs(id!, {
    refetchInterval: livePoll,
  });
  const { data: agents } = useAgents();
  const { data: users } = useUsers();
  const { data: costs, isLoading: costsLoading } = useSessionCosts({ taskId: id });
  const { data: contextData, isLoading: contextLoading } = useTaskContext(id!, {
    refetchInterval: livePoll,
  });
  // Steering (≥1.122.1), soft-degrade against older API servers, which 404
  // both `/steer` and `/steering-messages`.
  const steerGate = useFeatureGate("1.122.1");
  const { data: steeringEnabled = true } = useSteeringEnabled();
  const { data: steeringMessages } = useTaskSteeringMessages(id!, {
    enabled: steerGate.supported && steeringEnabled,
    refetchInterval: livePoll,
  });
  // A task that finishes while the page is open gets one last read: the final
  // log lines and context snapshot can land after the previous poll.
  const queryClient = useQueryClient();
  const wasLiveRef = useRef(false);
  useEffect(() => {
    const wasLive = wasLiveRef.current;
    wasLiveRef.current = taskLive;
    if (!wasLive || taskLive || !task) return;
    for (const part of ["session-logs", "context", "steering-messages"]) {
      void queryClient.invalidateQueries({ queryKey: ["task", task.id, part] });
    }
  }, [taskLive, task, queryClient]);
  // Composer dock is collapsible on this page only (the sessions surface is a
  // chat, its composer always stays put). Default expanded.
  const [composerCollapsed, setComposerCollapsed] = useLocalToggle(
    "tasks:steer-composer-collapsed",
    false,
  );
  // Draft is owned by the page, not the composer. Two reasons: the narrow and
  // wide layouts each mount their own <SteerComposer>, and the composer
  // itself unmounts whenever the task leaves a steerable status. Holding the
  // text here means crossing the 64rem layout switch, or a status flip that
  // hides and later restores the dock, doesn't eat what the user typed.
  const [steerDraft, setSteerDraft] = useState("");
  const cancelTask = useCancelTask();
  const pauseTask = usePauseTask();
  const resumeTask = useResumeTask();
  const { searchParams, setParam } = useUrlSearchState();
  // A finished task is opened for its result, so its mobile default tab is
  // Outcome; a live one opens on Details.
  const defaultTab = task && TERMINAL_STATUSES.has(task.status) ? "outcome" : "details";
  const activeTab = coerceTaskDetailTab(readStringParam(searchParams, "tab", defaultTab));
  const setActiveTab = useCallback(
    (tab: string) => setParam("tab", coerceTaskDetailTab(tab), { defaultValue: defaultTab }),
    [setParam, defaultTab],
  );
  // The wide layout's compact bar shows once the hero scrolls out of the
  // center column.
  const {
    past: heroScrolledPast,
    scrollerRef: centerScrollerRef,
    sentinelRef: heroEndRef,
  } = useHeroScrolledPast();
  const agentNames = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );
  const agentName = task?.agentId ? (agentNames.get(task.agentId) ?? null) : null;
  // Phase 3: read-only "Requested by" lookup. `useUsers()` is shared cache,
  // the identity boot modal already populated it.
  const requestedByUserName = useMemo(() => {
    if (!task?.requestedByUserId || !users) return null;
    return users.find((u) => u.id === task.requestedByUserId)?.name ?? null;
  }, [task, users]);

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

  const isTerminal = TERMINAL_STATUSES.has(task.status);
  const canCancel = !isTerminal && task.status !== "paused";
  const canPause = task.status === "in_progress";
  const canResume = task.status === "paused";

  // Steering reaches a running task directly, and a `pending` one by queueing:
  // the server holds the message and delivers it when the session starts.
  // Everything else falls back to the existing follow-up-task paths.
  const canSteer =
    steerGate.supported &&
    steeringEnabled &&
    (task.status === "in_progress" || task.status === "pending");

  const isFailed = task.status === "failed";
  const isCompleted = task.status === "completed";
  const hasSessionLogs = sessionLogs && sessionLogs.length > 0;
  const hasOutput = !!task.output;
  const hasAttachments = !!(task.attachments && task.attachments.length > 0);
  // The agent an Activity event is about. An offer's log row carries the
  // creator, so the offer names its target from the task instead.
  const eventAgentName = (log: AgentLog): string | null => {
    const agentId = log.eventType === "task_offered" ? task.offeredTo : log.agentId;
    return agentId ? (agentNames.get(agentId) ?? null) : null;
  };
  const offeredToName = task.offeredTo ? (agentNames.get(task.offeredTo) ?? null) : null;
  const waiting = describeWaiting(task, { agent: agentName, offeredTo: offeredToName });

  // Who, where from, when, cost, context, Activity and the technical ids. The
  // wide layout shows it as the right rail, the narrow one in its Details tab.
  const detailsRail = (
    <TaskDetailsRail
      task={task}
      agentName={agentName}
      requestedByName={requestedByUserName}
      agentNameFor={eventAgentName}
      costs={costs}
      costsLoading={costsLoading}
      context={contextData}
      contextLoading={contextLoading}
    />
  );

  const outcomeContent = (
    <div className="space-y-2">
      {isFailed && task.failureReason && (
        <CollapsibleSection
          variant="card"
          title="Failure Reason"
          icon={AlertTriangle}
          iconColor="text-status-error-strong"
          borderColor="border-status-error/30"
          bgColor="bg-status-error/5"
          defaultOpen
        >
          <div className="text-sm text-status-error-strong/80 leading-relaxed max-h-64 overflow-auto">
            <MarkdownView text={task.failureReason ?? ""} />
          </div>
        </CollapsibleSection>
      )}

      {hasOutput && (
        <CollapsibleSection
          variant="card"
          title="Output"
          icon={isCompleted ? CheckCircle2 : Terminal}
          iconColor={isCompleted ? "text-status-success-strong" : "text-muted-foreground"}
          borderColor={isCompleted ? "border-status-success/30" : "border-border"}
          bgColor={isCompleted ? "bg-status-success/5" : "bg-muted/20"}
          defaultOpen
        >
          <StructuredOutputContent
            citations={task.citations}
            raw={task.output ?? ""}
            maxH="max-h-[60vh]"
          />
        </CollapsibleSection>
      )}

      <TaskAttachmentsSection taskId={task.id} attachments={task.attachments} />
      <TaskCitationsSection output={task.output ?? ""} citations={task.citations ?? []} />

      {!isFailed && !hasOutput && !hasAttachments && (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <p className="text-xs">No output available</p>
        </div>
      )}
    </div>
  );

  // STEERING, no longer its own box above the logs. Delivered/handled rows
  // interleave into the SESSION LOGS stream at `deliveredAt`, promoted/
  // cancelled at `createdAt`, and still-pending ones pin to the tail box above
  // the "Agent is working…" footer. `undefined` when gated off, which makes
  // <SessionLogViewer> behave exactly as it did pre-steering.
  const steeringForViewer =
    steerGate.supported && steeringEnabled ? (steeringMessages ?? []) : undefined;
  const hasSteering = (steeringForViewer?.length ?? 0) > 0;

  // Render the viewer whenever there's anything to show, steering-only is a
  // real state right after the first message is queued but before the harness
  // has written any session log lines.
  const showLogViewer = hasSessionLogs || hasSteering;

  const sessionLogsContent = showLogViewer ? (
    <SessionLogViewer
      logs={sessionLogs ?? []}
      compactionSnapshots={contextData?.snapshots}
      isRunning={taskIsRunning(task.status)}
      steeringMessages={steeringForViewer}
      className="flex-1 min-h-0"
    />
  ) : sessionLogsLoading ? (
    // Do not claim "no session log" before the read answers.
    <Skeleton className="h-12 w-full shrink-0 rounded-lg" />
  ) : (
    // One line that says what the task waits for. Only a running task keeps
    // the full height free for logs that are coming; any other gives it to
    // the cards above.
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-dashed border-border px-4 py-3",
        taskIsRunning(task.status) ? "flex-1 min-h-40 justify-center" : "shrink-0",
      )}
    >
      <TaskStatusIcon status={task.status} />
      <p className="text-sm text-muted-foreground">{waiting}</p>
    </div>
  );

  const steerComposer = canSteer ? (
    <CollapsibleComposerDock
      collapsed={composerCollapsed}
      onCollapsedChange={setComposerCollapsed}
      collapsedLabel={
        task.supportedSteerModes && task.supportedSteerModes.length === 0
          ? "Add a follow-up for this task"
          : task.status === "pending"
            ? "Send a message to the queued task"
            : "Send a message to the running task"
      }
    >
      <SteerComposer
        taskId={task.id}
        supportedSteerModes={task.supportedSteerModes}
        providerLabel={task.provider}
        taskStatus={task.status}
        value={steerDraft}
        onValueChange={setSteerDraft}
        fullWidth
        className="px-0 pt-0 pb-0"
      />
    </CollapsibleComposerDock>
  ) : null;

  // HERO, status badge + tags / priority / source / provider / model badges +
  // collapsible description + action buttons. Rendered at the top of the center
  // column in the wide layout and above the Tabs in the narrow one. Same JSX in
  // both places, single-use; not extractable per the "appears in 2+ places" rule.
  const secondaryChips = [
    task.taskType ? (
      <Badge key="type" variant="outline" size="tag">
        {task.taskType}
      </Badge>
    ) : null,
    task.priority !== undefined ? (
      <Badge
        key="priority"
        variant="outline"
        className="text-[9px] px-1.5 py-0 h-5 font-mono leading-none items-center"
      >
        P{task.priority}
      </Badge>
    ) : null,
    ...(task.tags ?? []).map((tag) => (
      <Badge key={`tag-${tag}`} variant="outline" size="tag">
        {tag}
      </Badge>
    )),
    task.source ? (
      <Badge key="source" variant="outline" size="tag">
        {task.source}
      </Badge>
    ) : null,
    task.effort ? (
      <Badge
        key="effort"
        variant="outline"
        className="text-[9px] px-1.5 py-0 h-5 font-mono leading-none items-center gap-1"
      >
        <Zap className="h-2.5 w-2.5" />
        effort: {task.effort}
      </Badge>
    ) : null,
  ].filter((chip) => chip !== null);

  const headerTitle = taskListTitle(task);
  // Slack mention tokens read as names here too (`@Taras`, not `<@U…|Taras>`).
  const promptText = formatSlackMentions(task.task).trim();
  // The server records the model it resolved when the task was claimed
  // (`resolvedModel`, with the layer in `modelSource`). Older tasks and
  // unclaimed ones fall back to the requested `model`, then to whatever the
  // session_costs entries report.
  const displayModel = taskDisplayModel(task) ?? costs?.[0]?.model;
  // Each layout tree pads the hero itself.
  const heroBlock = (
    <div className="space-y-3 shrink-0">
      {/* The page's one heading. The breadcrumb truncates the title (and
          collapses to a few characters on a phone), so it cannot carry it. */}
      <TaskHeading title={headerTitle} />
      <div className="flex items-center gap-2 flex-wrap">
        <StatusBadge status={task.status} size="md" />
        {task.provider && (
          <Badge
            variant="outline"
            className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"
          >
            {task.provider}
            {task.harnessVariant ? (
              <span className="opacity-60">
                {" · "}
                {task.harnessVariant === "bridge"
                  ? `bridge${task.harnessVariantMeta?.version ? ` ${task.harnessVariantMeta.version}` : ""}`
                  : `stock${task.harnessVariantMeta?.version ? ` ${task.harnessVariantMeta.version}` : ""}`}
              </span>
            ) : task.harnessVariantMeta?.version ? (
              <span className="opacity-60">
                {" · "}
                {task.harnessVariantMeta.version}
              </span>
            ) : null}
            {task.providerMeta &&
            "transport" in task.providerMeta &&
            task.providerMeta.transport === "sdk" ? (
              <span className="opacity-60" title="Ran through the Claude Agent SDK transport">
                {" · "}
                sdk
              </span>
            ) : null}
          </Badge>
        )}
        {(() => {
          if (displayModel) {
            const badge = (
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 h-5 font-mono leading-none items-center"
              >
                {displayModel}
              </Badge>
            );
            const lines = describeModelResolution(task);
            if (lines.length === 0) return badge;
            return (
              <Tooltip>
                <TooltipTrigger asChild>{badge}</TooltipTrigger>
                <TooltipContent side="bottom" align="start">
                  {lines.map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </TooltipContent>
              </Tooltip>
            );
          }
          return task.modelTier ? (
            <Badge
              variant="outline"
              className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center"
            >
              tier: {modelTierLabel(task.modelTier)}
            </Badge>
          ) : null;
        })()}
        {/* Routing metadata (type, priority, tags, source, effort) sits
            behind one "+N" chip: eight equal-weight chips pushed the task
            text to the fourth row on a phone. */}
        {secondaryChips.length > 0 ? (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                aria-label={`Show ${secondaryChips.length} more task labels`}
              >
                <Badge variant="outline" size="tag" className="hover:bg-accent">
                  +{secondaryChips.length}
                </Badge>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto max-w-xs p-2">
              <div className="flex flex-wrap gap-1.5">{secondaryChips}</div>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>
      {/* A one-line prompt is already the heading; repeating it below read
          as the same sentence twice. The heading capitalizes the first word,
          so compare without case. */}
      {promptText.toLowerCase() !== headerTitle.toLowerCase() && (
        <CollapsibleDescription
          text={promptText}
          collapsedClassName="line-clamp-3 lg:line-clamp-2"
        />
      )}
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
              <CancelTaskButton
                onConfirm={() =>
                  cancelTask.mutate({ id: task.id, reason: "Cancelled from dashboard" })
                }
              />
            )}
          </div>
        )}
      </div>
    </div>
  );

  // The wide layout sizes the log card to fill the view. A running task keeps
  // that height before its first log line, so nothing jumps when logs arrive.
  const logFillsView = showLogViewer || taskIsRunning(task.status);

  return (
    // The layout follows the page's own width, not the window's: a docked
    // context panel or an open sidebar can leave a wide window with a narrow
    // page.
    <div className="@container flex flex-col flex-1 min-h-0">
      <TaskFailureHelpDialog task={task} />

      {/* Narrow (under 64rem of page width): the hero above three tabs. */}
      <div className="@min-[64rem]:hidden flex flex-col flex-1 min-h-0 overflow-hidden">
        <div className="px-1 pt-2 pb-4">{heroBlock}</div>
        <Separator className="shrink-0" />
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="flex flex-col flex-1 min-h-0"
        >
          <TabsList className="shrink-0 mx-1 mt-3 w-auto self-stretch">
            <TabsTrigger value="details">Details</TabsTrigger>
            <TabsTrigger value="outcome">Outcome</TabsTrigger>
            <TabsTrigger value="logs">Session Logs</TabsTrigger>
          </TabsList>
          <TabsContent value="details" className="flex-1 overflow-y-auto px-1 py-3">
            {detailsRail}
          </TabsContent>
          <TabsContent value="outcome" className="flex-1 overflow-y-auto px-1 py-3">
            {outcomeContent}
          </TabsContent>
          <TabsContent value="logs" className="flex flex-col flex-1 min-h-0 px-1 py-3 gap-3">
            {sessionLogsContent}
            {steerComposer}
          </TabsContent>
        </Tabs>
      </div>

      {/* Wide: a scrolling center column and the details rail. The grid
          bleeds into <main>'s vertical padding, so the column scrolls from
          under the app header down to the window edge and the log gets those
          pixels. */}
      <div className="hidden @min-[64rem]:grid flex-1 min-h-0 grid-cols-[minmax(0,1fr)_300px] -my-4 md:-my-6">
        {/* The column is a size container: the log card reads its height
            (100cqh). The log viewer keeps its own scroller, so its
            virtualization, stick-to-bottom and "N new" pill work unchanged. */}
        <section
          ref={centerScrollerRef}
          style={{ "--task-bar-h": STICKY_BAR_HEIGHT } as CSSProperties}
          className="relative min-h-0 overflow-y-auto [scrollbar-gutter:stable] [container-type:size]"
        >
          <TaskStickyBar
            visible={heroScrolledPast}
            title={headerTitle}
            status={task.status}
            model={displayModel}
          />
          <div className="flex flex-col gap-3 pt-6 pr-6 pb-3">
            <div className="pb-2">
              {heroBlock}
              <div ref={heroEndRef} aria-hidden className="h-px" />
            </div>
            <Separator />
            {isFailed && task.failureReason && (
              <CollapsibleSection
                variant="card"
                title="Failure Reason"
                icon={AlertTriangle}
                iconColor="text-status-error-strong"
                borderColor="border-status-error/30"
                bgColor="bg-status-error/5"
              >
                <div className="text-sm text-status-error-strong/80 leading-relaxed max-h-48 overflow-auto">
                  <MarkdownView text={task.failureReason ?? ""} />
                </div>
              </CollapsibleSection>
            )}

            {hasOutput && (
              <CollapsibleSection
                variant="card"
                title="Output"
                icon={isCompleted ? CheckCircle2 : Terminal}
                iconColor={isCompleted ? "text-status-success-strong" : "text-muted-foreground"}
                borderColor={isCompleted ? "border-status-success/30" : "border-border"}
                bgColor={isCompleted ? "bg-status-success/5" : "bg-muted/20"}
                // A finished task is opened for its result; keep it collapsed
                // while the task runs so the live log stays in view.
                defaultOpen={isTerminal}
              >
                {/* No height cap: the column scrolls. */}
                <StructuredOutputContent
                  citations={task.citations}
                  raw={task.output ?? ""}
                  maxH=""
                />
              </CollapsibleSection>
            )}

            <TaskAttachmentsSection taskId={task.id} attachments={task.attachments} />
            <TaskCitationsSection output={task.output ?? ""} citations={task.citations ?? []} />

            {logFillsView ? (
              // Scrolled into view, the log card (and the live composer under
              // it) fills the column under the sticky bar: the column height
              // minus the bar, the gap under the bar, and the bottom padding.
              <div className="flex shrink-0 flex-col gap-3 h-[max(20rem,calc(100cqh_-_var(--task-bar-h)_-_1.5rem))]">
                {sessionLogsContent}
                {steerComposer}
              </div>
            ) : (
              <>
                {sessionLogsContent}
                {steerComposer}
              </>
            )}
          </div>
        </section>

        <aside
          aria-label="Task details"
          className="min-h-0 overflow-y-auto border-l border-border py-6 pl-5"
        >
          {detailsRail}
        </aside>
      </div>
    </div>
  );
}
