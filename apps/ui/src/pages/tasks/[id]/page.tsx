import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Tag, Terminal } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  renderTaskCitationSources,
  renderTaskCitations,
  type TaskCitation,
} from "../../../../../../src/utils/task-citations";
import "streamdown/styles.css";
import { useAgents } from "@/api/hooks/use-agents";
import { useSessionCosts } from "@/api/hooks/use-costs";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSession } from "@/api/hooks/use-sessions";
import { useSteeringEnabled } from "@/api/hooks/use-stats";
import {
  useTask,
  useTaskContext,
  useTaskSessionLogs,
  useTaskSteeringMessages,
} from "@/api/hooks/use-tasks";
import { useUsers } from "@/api/hooks/use-users";
import type { AgentLog, AgentTask, AgentTaskStatus } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { MarkdownView } from "@/components/shared/markdown-view";
import { ModelLabel } from "@/components/shared/model-logo";
import { REASONING_EFFORT_LABEL } from "@/components/shared/reasoning-effort-icon";
import { SessionLogViewer } from "@/components/shared/session-log-viewer";
import { StatusBadge } from "@/components/shared/status-badge";
import { TaskAttachmentsSection } from "@/components/shared/task-attachments-section";
import { TaskCitationsSection } from "@/components/shared/task-citations-section";
import { TaskComposer } from "@/components/shared/task-composer";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { CollapsibleComposerDock } from "@/components/steering/collapsible-composer-dock";
import { TaskFailureHelpDialog } from "@/components/support/task-failure-help-dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocalToggle } from "@/hooks/use-local-toggle";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { formatDurationMs } from "@/lib/format-duration-ms";
import { modelTierLabel } from "@/lib/model-tiers";
import { TERMINAL_STATUSES, taskIsRunning } from "@/lib/task-activity";
import { linkTaskIds } from "@/lib/task-links";
import { describeModelResolution, taskDisplayModel } from "@/lib/task-model-resolution";
import { taskListTitle } from "@/lib/task-title";
import { cn, formatRelativeTime, parseUTCDate } from "@/lib/utils";
import { directChildren, SpawnedTasks } from "./spawned-tasks";
import {
  parseStructuredOutput,
  TaskActions,
  TaskFailureCallout,
  TaskPrimaryAction,
  useTaskActions,
} from "./task-actions";
import { TaskDetailsRail } from "./task-details-rail";
import { TaskSourceLine } from "./task-source-line";
import {
  STICKY_BAR_HEIGHT,
  scrollToTop,
  TaskEffortMark,
  TaskStickyBar,
  useElementHeight,
  useHeroScrolledPast,
} from "./task-sticky-bar";

const TASK_DETAIL_TABS = new Set(["details", "outcome", "logs"]);

function coerceTaskDetailTab(value: string): string {
  return TASK_DETAIL_TABS.has(value) ? value : "details";
}

/**
 * Task title as the page heading, at most two lines. A clamped title shows
 * in full in a tooltip. "View full prompt" (the source line) has the whole
 * prompt for keyboard users.
 */
function TaskHeading({ title }: { title: string }) {
  const [heading, setHeading] = useState<HTMLHeadingElement | null>(null);
  const [clamped, setClamped] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!heading) return;
    const measure = () => setClamped(heading.scrollHeight > heading.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(heading);
    measure();
    return () => observer.disconnect();
  }, [heading]);
  return (
    // Stays mounted: only `open` follows the clamp.
    <Tooltip open={clamped && open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <h1
          // A new title is a new heading, measured again: a 2-line and a
          // 3-line title clamp to the same height, so no resize fires.
          key={title}
          ref={setHeading}
          className="line-clamp-2 text-lg font-semibold leading-snug text-balance break-words"
        >
          {title}
        </h1>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-lg text-left text-pretty">
        {title}
      </TooltipContent>
    </Tooltip>
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

/**
 * How long a failed task ran: created to finished, or the harness run time
 * when the task has no finish time.
 */
function failedAfter(task: AgentTask, costDurationMs: number): string | null {
  if (task.finishedAt) {
    const ms = parseUTCDate(task.finishedAt).getTime() - parseUTCDate(task.createdAt).getTime();
    if (ms > 0) return formatDurationMs(ms);
  }
  return costDurationMs > 0 ? formatDurationMs(costDurationMs) : null;
}

/** Task ids in the answer link to their pages. `taskIds` are the ids the page knows. */
function StructuredOutputContent({
  raw,
  maxH,
  citations = [],
  taskIds,
}: {
  raw: string;
  maxH: string;
  citations?: TaskCitation[];
  taskIds: readonly string[];
}) {
  const structured = parseStructuredOutput(raw);
  if (!structured) {
    return (
      <div className={`text-sm leading-relaxed overflow-auto text-foreground/80 ${maxH}`}>
        <MarkdownView
          text={linkTaskIds(renderTaskCitations(raw, citations, "markdown"), taskIds)}
        />
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
              text={linkTaskIds(
                renderTaskCitations(structured.summary, citations, "markdown", false),
                taskIds,
              )}
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
              text={linkTaskIds(
                renderTaskCitations(structured.output, citations, "markdown", false),
                taskIds,
              )}
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

/** The follow-up box in view and focused: the wide or the narrow one, whichever shows. */
function focusVisibleComposer(boxes: (HTMLElement | null)[]): boolean {
  const box = boxes.find((element) => element && element.getClientRects().length > 0);
  const textarea = box?.querySelector("textarea");
  if (!box || !textarea) return false;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  box.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
  textarea.focus({ preventScroll: true });
  return true;
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
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
  // The tasks this one started (≥1.76.0): `GET /api/sessions/{id}` returns
  // every descendant for any task id. Children can join late (a follow-up, a
  // retry), so it keeps its slow poll after the task finishes.
  const sessionsGate = useFeatureGate("1.76.0");
  const { data: session } = useSession(sessionsGate.supported ? id : undefined);
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
  // The draft is owned by the page, not the composer. The narrow and wide
  // layouts each mount their own <TaskComposer>, and the box moves when the
  // task finishes (the steer box under the log, the follow-up box under the
  // outcome). Holding the text here means crossing the 64rem layout switch,
  // or a status flip, does not eat what the user typed.
  const [draft, setDraft] = useState("");
  // The support dialog opens only from "Get help".
  const [helpOpen, setHelpOpen] = useState(false);
  // A draft and an open dialog belong to one task: Retry and the spawned task
  // links move this page to another task id.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new task id only.
  useEffect(() => {
    setDraft("");
    setHelpOpen(false);
  }, [id]);
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
  // center column. The column is the page's one scroller: the log flows in it.
  const {
    past: heroScrolledPast,
    scroller: centerScroller,
    scrollerRef: centerScrollerRef,
    sentinelRef: heroEndRef,
  } = useHeroScrolledPast();
  // The wide layout's live message box sticks to the bottom of the column. Its
  // height goes to the log as `--log-sticky-bottom`.
  const [composerHeight, composerRef] = useElementHeight();
  // "Follow up" scrolls to the follow-up box and focuses it. In the narrow
  // layout the box is on the Outcome tab, which mounts a render or two after
  // the tab switch: the boxes are state, so their arrival runs the effect.
  const [wideFollowUpBox, setWideFollowUpBox] = useState<HTMLDivElement | null>(null);
  const [narrowFollowUpBox, setNarrowFollowUpBox] = useState<HTMLDivElement | null>(null);
  const followUpPendingRef = useRef(false);
  const [followUpRequest, setFollowUpRequest] = useState(0);
  const requestFollowUp = useCallback(() => {
    followUpPendingRef.current = true;
    setActiveTab("outcome");
    setFollowUpRequest((n) => n + 1);
  }, [setActiveTab]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new request re-runs it.
  useEffect(() => {
    if (!followUpPendingRef.current) return;
    if (focusVisibleComposer([wideFollowUpBox, narrowFollowUpBox])) {
      followUpPendingRef.current = false;
    }
  }, [followUpRequest, wideFollowUpBox, narrowFollowUpBox]);
  const actions = useTaskActions(task, {
    onFollowUp: requestFollowUp,
    onGetHelp: () => setHelpOpen(true),
  });
  const announceFollowUp = useCallback(
    (created: AgentTask) => {
      toast.success("Follow-up task created.", {
        action: { label: "Open", onClick: () => void navigate(`/tasks/${created.id}`) },
      });
    },
    [navigate],
  );
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

  if (!task || !actions) {
    return <p className="text-muted-foreground">Task not found.</p>;
  }

  const isTerminal = TERMINAL_STATUSES.has(task.status);

  // Steering reaches any assignee: a running task directly, a `pending` one by
  // queueing until its session starts, and a `paused` one by resuming it.
  // A finished task gets the follow-up box instead.
  const canSteer =
    steerGate.supported &&
    steeringEnabled &&
    (task.status === "in_progress" || task.status === "pending" || task.status === "paused");

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

  // The tasks this task started, and the ids the answer may mention.
  const chain = session?.chain ?? [];
  const spawned = directChildren(task.id, chain);
  const knownTaskIds = [...chain.map((t) => t.id), task.parentTaskId].filter(
    (taskId): taskId is string => !!taskId && taskId !== task.id,
  );
  const spawnedTasks = (
    <SpawnedTasks tasks={spawned} agentNameFor={(agentId) => agentNames.get(agentId) ?? null} />
  );

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

  // A failed task's error, always open, with Retry and Get help.
  const failureCallout = isFailed ? (
    <TaskFailureCallout
      model={actions}
      duration={failedAfter(task, costs?.reduce((sum, cost) => sum + cost.durationMs, 0) ?? 0)}
    />
  ) : null;

  // FOLLOW UP: a finished task gets the shared message box right under its
  // outcome. It creates a child task for the same agent; a Slack task answers
  // in the same thread. Each layout tree mounts its own box on the one draft.
  const renderFollowUp = (ref: (box: HTMLDivElement | null) => void) =>
    isTerminal ? (
      <div ref={ref} className="shrink-0">
        <TaskComposer
          targetTask={task}
          canSteer={false}
          followUpAgentId={task.agentId ?? undefined}
          routeLabel={task.agentId ? `Routes to ${agentName ?? "the same agent"}` : undefined}
          value={draft}
          onValueChange={setDraft}
          onCreated={announceFollowUp}
          fullWidth
          className="px-0 pt-0 pb-0"
        />
      </div>
    ) : null;

  const outcomeContent = (
    <div className="space-y-2">
      {failureCallout}

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
            taskIds={knownTaskIds}
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

      {spawnedTasks}
      {renderFollowUp(setNarrowFollowUpBox)}
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

  // The wide layout passes its column as `scrollElement`, so the log flows in
  // the page scroller. The narrow one keeps the viewer's own scroller.
  const renderSessionLogs = (scrollElement?: HTMLElement | null) =>
    showLogViewer ? (
      <SessionLogViewer
        logs={sessionLogs ?? []}
        compactionSnapshots={contextData?.snapshots}
        isRunning={taskIsRunning(task.status)}
        steeringMessages={steeringForViewer}
        scrollElement={scrollElement}
        className={scrollElement === undefined ? "flex-1 min-h-0" : undefined}
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

  // The live message box: it steers the task, as before. It sits under the
  // log, folded or open.
  const steerComposer = canSteer ? (
    <CollapsibleComposerDock
      collapsed={composerCollapsed}
      onCollapsedChange={setComposerCollapsed}
      collapsedLabel={
        task.supportedSteerModes && task.supportedSteerModes.length === 0
          ? "Add a follow-up for this task"
          : task.status === "pending"
            ? "Send a message to the queued task"
            : task.status === "paused"
              ? "Send a message to the paused task"
              : "Send a message to the running task"
      }
    >
      <TaskComposer
        targetTask={task}
        canSteer
        followUpAgentId={task.agentId ?? undefined}
        value={draft}
        onValueChange={setDraft}
        fullWidth
        className="px-0 pt-0 pb-0"
      />
    </CollapsibleComposerDock>
  ) : null;

  const headerTitle = taskListTitle(task);
  // The server records the model it resolved when the task was claimed
  // (`resolvedModel`, with the layer in `modelSource`). Older tasks and
  // unclaimed ones fall back to the requested `model`, then to whatever the
  // session_costs entries report.
  const displayModel = taskDisplayModel(task) ?? costs?.[0]?.model;
  const creatorName =
    task.creatorAgentId && task.creatorAgentId !== task.agentId
      ? (agentNames.get(task.creatorAgentId) ?? null)
      : null;

  // HERO CHIPS: status, model (with the effort icon when the task sets one)
  // and agent, then the tags as plain text. The harness, type, priority and
  // source are in Technical details. The model chip takes focus, so keyboard
  // users get the exact model id.
  const modelChip = displayModel ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" tabIndex={0} className="h-6 max-w-full gap-1.5 px-2">
          <ModelLabel model={displayModel} />
          <TaskEffortMark effort={task.effort} className="text-muted-foreground" />
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="text-left">
        <div className="font-mono">{displayModel}</div>
        {describeModelResolution(task).map((line) => (
          <div key={line}>{line}</div>
        ))}
        {task.effort ? <div>Effort: {REASONING_EFFORT_LABEL[task.effort]}</div> : null}
      </TooltipContent>
    </Tooltip>
  ) : task.modelTier ? (
    <Badge variant="outline" className="h-6 gap-1.5 px-2">
      {modelTierLabel(task.modelTier)} tier
      <TaskEffortMark effort={task.effort} className="text-muted-foreground" />
    </Badge>
  ) : null;
  const agentChip = task.agentId ? (
    <Badge variant="outline" asChild className="h-6 max-w-full gap-1.5 pr-2 pl-0.5">
      <Link to={`/agents/${task.agentId}`}>
        <AgentAvatar
          agentId={task.agentId}
          agentName={agentName}
          size="xs"
          className="h-4.5 w-4.5 shadow-none"
        />
        <span className="sr-only">Agent: </span>
        <span className="min-w-0 truncate">{agentName ?? `${task.agentId.slice(0, 8)}…`}</span>
      </Link>
    </Badge>
  ) : null;
  const tagsLine =
    task.tags && task.tags.length > 0 ? (
      <span className="ml-1 inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
        <Tag aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only">Tags: </span>
        <span className="min-w-0 truncate">{task.tags.join(", ")}</span>
      </span>
    ) : null;

  // HERO: the title, where the task came from, the chips, and the actions.
  // Rendered at the top of the center column in the wide layout and above the
  // Tabs in the narrow one. Each layout tree pads the hero itself. Wide: the
  // actions sit right of the title. Narrow: they come last, under the chips.
  const heroBlock = (
    <div className="grid shrink-0 grid-cols-1 gap-2.5 @min-[64rem]:grid-cols-[minmax(0,1fr)_auto] @min-[64rem]:gap-x-6">
      {/* The page's one heading. The breadcrumb truncates the title (and
          collapses to a few characters on a phone), so it cannot carry it. */}
      <div className="min-w-0">
        <TaskHeading title={headerTitle} />
      </div>
      <TaskActions
        model={actions}
        className="order-last pt-1 @min-[64rem]:order-none @min-[64rem]:row-span-3 @min-[64rem]:self-start @min-[64rem]:justify-end @min-[64rem]:pt-0"
      />
      <TaskSourceLine task={task} requestedByName={requestedByUserName} creatorName={creatorName} />
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={task.status} size="md" />
        {modelChip}
        {agentChip}
        {tagsLine}
      </div>
    </div>
  );

  return (
    // The layout follows the page's own width, not the window's: a docked
    // context panel or an open sidebar can leave a wide window with a narrow
    // page.
    <div className="@container flex flex-col flex-1 min-h-0">
      {isFailed ? (
        <TaskFailureHelpDialog task={task} open={helpOpen} onOpenChange={setHelpOpen} />
      ) : null}

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
            {renderSessionLogs()}
            {steerComposer}
          </TabsContent>
        </Tabs>
      </div>

      {/* Wide: a scrolling center column and the details rail. The grid
          bleeds into <main>'s vertical padding, so the column scrolls from
          under the app header down to the window edge and the log gets those
          pixels. */}
      <div className="hidden @min-[64rem]:grid flex-1 min-h-0 grid-cols-[minmax(0,1fr)_300px] -my-4 md:-my-6">
        {/* The column is the only scroller. The log flows in it, and its
            toolbar, minimap and live footer stick under the bar and above the
            message box: both heights go to the log as CSS variables. */}
        <section
          ref={centerScrollerRef}
          style={
            {
              "--log-sticky-top": STICKY_BAR_HEIGHT,
              "--log-sticky-bottom": `${composerHeight}px`,
            } as CSSProperties
          }
          className="relative min-h-0 overflow-y-auto [scrollbar-gutter:stable]"
        >
          <TaskStickyBar
            visible={heroScrolledPast}
            title={headerTitle}
            status={task.status}
            model={displayModel}
            effort={task.effort}
            action={<TaskPrimaryAction model={actions} />}
            onTitleClick={() => scrollToTop(centerScroller)}
          />
          <div className="flex flex-col gap-3 pt-6 pr-6 pb-3">
            <div className="pb-2">
              {heroBlock}
              <div ref={heroEndRef} aria-hidden className="h-px" />
            </div>
            <Separator />
            {failureCallout}

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
                  taskIds={knownTaskIds}
                />
              </CollapsibleSection>
            )}

            <TaskAttachmentsSection taskId={task.id} attachments={task.attachments} />
            <TaskCitationsSection output={task.output ?? ""} citations={task.citations ?? []} />
            {spawnedTasks}
            {renderFollowUp(setWideFollowUpBox)}

            {renderSessionLogs(centerScroller)}
            {steerComposer ? (
              // The message box sticks to the bottom of the column. `-my-3
              // py-3` moves the column gap and the bottom padding into the
              // sticky box: the stuck box keeps both, and the scroll height
              // does not change.
              <div ref={composerRef} className="sticky bottom-0 z-10 -my-3 bg-background py-3">
                {steerComposer}
              </div>
            ) : null}
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
