import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, PanelRightClose, PanelRightOpen, Tag } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  useRequestComposition,
  useTask,
  useTaskContext,
  useTaskSessionLogs,
  useTaskSteeringMessages,
} from "@/api/hooks/use-tasks";
import { useUsers } from "@/api/hooks/use-users";
import type { AgentTask, AgentTaskStatus } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { EffortMark } from "@/components/shared/effort-mark";
import { MarkdownView } from "@/components/shared/markdown-view";
import { ModelEffortLabel } from "@/components/shared/model-effort-label";
import { REASONING_EFFORT_LABEL } from "@/components/shared/reasoning-effort-icon";
import {
  CallCompositionContext,
  NO_CALL_COMPOSITIONS,
} from "@/components/shared/request-composition-bar";
import { SessionLogViewer } from "@/components/shared/session-log-viewer";
import { ShowMore } from "@/components/shared/show-more";
import { StatusBadge } from "@/components/shared/status-badge";
import { TaskAttachmentsSection } from "@/components/shared/task-attachments-section";
import { TaskCitationsSection } from "@/components/shared/task-citations-section";
import { TaskComposer } from "@/components/shared/task-composer";
import { TaskStatusIcon } from "@/components/shared/task-status-icon";
import { TaskTranscript } from "@/components/shared/transcript/task-transcript";
import { buildTranscriptRows } from "@/components/shared/transcript/transcript-rows";
import { CollapsibleComposerDock } from "@/components/steering/collapsible-composer-dock";
import { TaskFailureHelpDialog } from "@/components/support/task-failure-help-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLocalToggle } from "@/hooks/use-local-toggle";
import { readStringParam, useUrlSearchState } from "@/hooks/use-url-search-state";
import { CHAT_COLUMN } from "@/lib/chat-width";
import { MAIN_BLEED, MAIN_BLEED_Y, MAIN_GUTTER_X } from "@/lib/main-gutter";
import { modelTierLabel } from "@/lib/model-tiers";
import { compositionCallsOf, deriveCallCompositions } from "@/lib/request-composition";
import { useUsageDetails } from "@/lib/session-log-usage-details";
import { parseStructuredOutput } from "@/lib/structured-output";
import { TERMINAL_STATUSES, taskIsRunning } from "@/lib/task-activity";
import { linkTaskIds } from "@/lib/task-links";
import {
  describeModelResolution,
  taskDisplayEffort,
  taskDisplayModel,
} from "@/lib/task-model-resolution";
import { canSteerTask } from "@/lib/task-steer";
import { taskListTitle } from "@/lib/task-title";
import { cn, formatRelativeTime } from "@/lib/utils";
import { normalizeSessionLogs, parseSessionLogs, sumItemCallUsage } from "@/logs-parser";
import { directChildren, SpawnedTasks } from "./spawned-tasks";
import {
  TaskActions,
  TaskActionsMenu,
  TaskFailureCallout,
  TaskPrimaryAction,
  useTaskActions,
} from "./task-actions";
import { TaskDetailsRail, taskRunTime } from "./task-details-rail";
import { TaskSourceLine } from "./task-source-line";
import {
  STICKY_BAR_HEIGHT,
  scrollToTop,
  TaskStickyBar,
  useHeroScrolledPast,
} from "./task-sticky-bar";
import { useElementHeight } from "./use-element-height";

/**
 * The narrow layout's tabs: the transcript, then the side panel's tabs. The
 * `?tab=` values predate the labels: Transcript is `logs`.
 */
const TASK_DETAIL_TABS = new Set(["logs", "details", "tree", "files"]);

/** The wide layout's side panel tabs, modelled on T3 Code's right panel. `?panel=` keeps the pick. */
const SIDE_PANEL_TABS = new Set(["details", "tree", "files"]);

/** The focus ring of a narrow tab panel (the panel itself is a Tab stop). */
const PANEL_FOCUS_RING = "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60";

function coerceTaskDetailTab(value: string, fallback: string): string {
  return TASK_DETAIL_TABS.has(value) ? value : fallback;
}

function coerceSidePanelTab(value: string): string {
  return SIDE_PANEL_TABS.has(value) ? value : "details";
}

/**
 * The narrow layout's first tab, whatever the status: the transcript is the
 * page's main view, as in the wide layout's center column. An expanded app
 * sidebar can push a desktop window into this layout too.
 */
const DEFAULT_TASK_TAB = "logs";

/**
 * The log's views: the transcript (the shared chat renderer, also on the
 * Sessions page) or the raw log with every event. `?log=raw` keeps the pick.
 */
type LogMode = "transcript" | "raw";

const LOG_MODE_OPTIONS = [
  { value: "transcript", label: "Transcript" },
  { value: "raw", label: "Raw log" },
] as const satisfies readonly { value: LogMode; label: string }[];

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
 * Task ids in the answer link to their pages, in the same tab, like the
 * spawned task rows. `taskIds` are the ids the page knows.
 */
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
  const taskLinks = new Set(taskIds.map((taskId) => `/tasks/${taskId}`));
  const structured = parseStructuredOutput(raw);
  if (!structured) {
    return (
      <div className={`text-sm leading-relaxed overflow-auto text-foreground ${maxH}`}>
        <MarkdownView
          text={linkTaskIds(renderTaskCitations(raw, citations, "markdown"), taskIds)}
          sameTabHrefs={taskLinks}
        />
      </div>
    );
  }
  return (
    <div className={`space-y-3 overflow-auto ${maxH}`}>
      {structured.summary && (
        <div>
          <span className="text-meta font-semibold text-muted-foreground uppercase tracking-wider">
            Summary
          </span>
          <div className="mt-1 text-sm leading-relaxed text-foreground">
            <MarkdownView
              text={linkTaskIds(
                renderTaskCitations(structured.summary, citations, "markdown", false),
                taskIds,
              )}
              sameTabHrefs={taskLinks}
            />
          </div>
        </div>
      )}
      {structured.output && (
        <div>
          <span className="text-meta font-semibold text-muted-foreground uppercase tracking-wider">
            Output
          </span>
          <div className="mt-1 text-sm leading-relaxed text-foreground">
            <MarkdownView
              text={linkTaskIds(
                renderTaskCitations(structured.output, citations, "markdown", false),
                taskIds,
              )}
              sameTabHrefs={taskLinks}
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

/**
 * Focuses the message box that shows. Both layouts pin it under their
 * scroller, so it is always in view.
 */
function focusVisibleComposer(wideBox: HTMLElement | null, narrowBar: HTMLElement | null) {
  const shown = (element: HTMLElement | null) => !!element && element.getClientRects().length > 0;
  const box = shown(wideBox) ? wideBox : shown(narrowBar) ? narrowBar : null;
  box?.querySelector("textarea")?.focus({ preventScroll: true });
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: task, isLoading } = useTask(id!);
  // A finished task's log, context and steering rows are frozen history: read
  // them once, with no poll and no refetch on window focus or reconnect
  // (`staleTime: Infinity`). Until the task itself loads, hold the poll too,
  // so a finished task never gets a second read. `undefined` keeps each
  // hook's live cadence.
  const taskLive = !!task && !TERMINAL_STATUSES.has(task.status);
  const liveReads = taskLive
    ? undefined
    : task
      ? { refetchInterval: false as const, staleTime: Number.POSITIVE_INFINITY }
      : { refetchInterval: false as const };
  const { data: sessionLogs, isLoading: sessionLogsLoading } = useTaskSessionLogs(id!, liveReads);
  const { data: agents } = useAgents();
  const { data: users } = useUsers();
  const { data: costs, isLoading: costsLoading } = useSessionCosts({ taskId: id });
  const { data: contextData, isLoading: contextLoading } = useTaskContext(id!, liveReads);
  // Steering (≥1.122.1), soft-degrade against older API servers, which 404
  // both `/steer` and `/steering-messages`.
  const steerGate = useFeatureGate("1.122.1");
  const { data: steeringEnabled = true } = useSteeringEnabled();
  const { data: steeringMessages } = useTaskSteeringMessages(id!, {
    enabled: steerGate.supported && steeringEnabled,
    ...liveReads,
  });
  // The tasks this one started (≥1.76.0): `GET /api/sessions/{id}` returns
  // every descendant for any task id. Children can join late (a follow-up, a
  // retry), so it keeps its slow poll after the task finishes.
  const sessionsGate = useFeatureGate("1.76.0");
  const { data: session } = useSession(sessionsGate.supported ? id : undefined);
  // A task that finishes while the page is open gets one last read: the final
  // log lines and context snapshot can land after the previous poll. An
  // invalidation refetches even under `staleTime: Infinity`.
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
  // layouts each mount their own <TaskComposer>, and the wide box moves when
  // the task finishes (the steer box under the log, the follow-up box under
  // the outcome). Holding the text here means crossing the 60rem layout
  // switch, a status flip, or a narrow tab switch does not eat what the user
  // typed.
  const [draft, setDraft] = useState("");
  // The support dialog opens only from "Get help", and gives focus back to it
  // (or to the "..." trigger of the menu that held it) when it closes.
  const [helpOpen, setHelpOpen] = useState(false);
  const helpOpener = useRef<HTMLElement | null>(null);
  // A draft and an open dialog belong to one task: Retry and the spawned task
  // links move this page to another task id.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new task id only.
  useEffect(() => {
    setDraft("");
    setHelpOpen(false);
  }, [id]);
  const { searchParams, setParam } = useUrlSearchState();
  const activeTab = coerceTaskDetailTab(
    readStringParam(searchParams, "tab", DEFAULT_TASK_TAB),
    DEFAULT_TASK_TAB,
  );
  const setActiveTab = useCallback(
    (tab: string) =>
      setParam("tab", coerceTaskDetailTab(tab, DEFAULT_TASK_TAB), {
        defaultValue: DEFAULT_TASK_TAB,
      }),
    [setParam],
  );
  // Transcript or raw log, shared by both layouts.
  const logMode: LogMode =
    readStringParam(searchParams, "log", "transcript") === "raw" ? "raw" : "transcript";
  const setLogMode = useCallback(
    (mode: LogMode) => setParam("log", mode, { defaultValue: "transcript" }),
    [setParam],
  );
  // The side panel next to the column folds away, as the app sidebar does.
  const [detailsCollapsed, setDetailsCollapsed] = useLocalToggle(
    "tasks:details-panel-collapsed",
    false,
  );
  const sidePanelTab = coerceSidePanelTab(readStringParam(searchParams, "panel", "details"));
  const setSidePanelTab = useCallback(
    (tab: string) => setParam("panel", coerceSidePanelTab(tab), { defaultValue: "details" }),
    [setParam],
  );
  // The wide layout's compact bar shows once the hero scrolls out of the
  // center column. The column is the page's one scroller: the log flows in it.
  const {
    past: heroScrolledPast,
    scroller: centerScroller,
    scrollerRef: centerScrollerRef,
    sentinelRef: heroEndRef,
  } = useHeroScrolledPast();
  // The narrow layout scrolls as one above the pinned message box: the hero
  // scrolls away and the tabs stick. Their height goes to the log as
  // `--log-sticky-top`.
  const [narrowScroller, setNarrowScroller] = useState<HTMLElement | null>(null);
  const [narrowHeroHeight, narrowHeroRef] = useElementHeight();
  const [narrowTabsHeight, narrowTabsRef] = useElementHeight();
  const [narrowBar, narrowBarRef] = useState<HTMLElement | null>(null);
  // A tab switch while the tabs are stuck shows the new tab from its top,
  // right under the tabs. With the hero still in view, nothing moves.
  const shownTabRef = useRef(activeTab);
  useLayoutEffect(() => {
    if (shownTabRef.current === activeTab) return;
    shownTabRef.current = activeTab;
    if (narrowScroller && narrowScroller.scrollTop > narrowHeroHeight) {
      narrowScroller.scrollTop = narrowHeroHeight;
    }
  }, [activeTab, narrowScroller, narrowHeroHeight]);
  // "Follow up" focuses the message box: the wide layout's or the narrow
  // layout's, each pinned under its scroller.
  const wideFollowUpBoxRef = useRef<HTMLDivElement | null>(null);
  const requestFollowUp = useCallback(
    () => focusVisibleComposer(wideFollowUpBoxRef.current, narrowBar),
    [narrowBar],
  );
  const actions = useTaskActions(task, {
    onFollowUp: requestFollowUp,
    onGetHelp: (opener) => {
      helpOpener.current = opener;
      setHelpOpen(true);
    },
  });
  // A follow-up on a finished task is a new task: the page moves to it once
  // it starts. The composer holds a task whose files failed to upload, so the
  // page stays on its retry notice until then.
  const announceFollowUp = useCallback(
    (created: AgentTask) => {
      toast.success("Follow-up task created.");
      void navigate(`/tasks/${created.id}`);
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
  // The rail's cache hit, from the session log this page already loads. Only
  // with the log's usage details on.
  const [usageDetails] = useUsageDetails();
  const usageItems = useMemo(
    () => (usageDetails ? normalizeSessionLogs(sessionLogs ?? []).items : null),
    [sessionLogs, usageDetails],
  );
  const callUsage = useMemo(() => (usageItems ? sumItemCallUsage(usageItems) : null), [usageItems]);
  // The transcript's rows: the agent's prose, tool runs, steering and the
  // tasks it delegated, in time order. Task events stay out.
  const transcriptSteering = steerGate.supported && steeringEnabled ? steeringMessages : undefined;
  const delegated = useMemo(
    () =>
      directChildren(id!, session?.chain ?? []).map((child) => ({
        task: child,
        agentName: child.agentId ? (agentNames.get(child.agentId) ?? null) : null,
      })),
    [id, session, agentNames],
  );
  const transcriptRows = useMemo(
    () =>
      buildTranscriptRows({
        messages: parseSessionLogs(sessionLogs ?? []),
        steering: transcriptSteering,
        children: delegated,
      }),
    [sessionLogs, transcriptSteering, delegated],
  );
  // The request composition: the rail's panel and each cache chip's bar.
  // Also only with usage details on.
  const logSessionIds = useMemo(
    () => [...new Set((sessionLogs ?? []).map((log) => log.sessionId))],
    [sessionLogs],
  );
  const { data: manifests } = useRequestComposition(id!, {
    enabled: usageDetails && logSessionIds.length > 0,
    sessionIds: logSessionIds,
    live: taskLive,
  });
  const compositions = useMemo(() => {
    if (!usageItems || !manifests?.length) return null;
    const sessionOfRecord = new Map((sessionLogs ?? []).map((log) => [log.id, log.sessionId]));
    const compactions = (contextData?.snapshots ?? [])
      .filter((snap) => snap.eventType === "compaction")
      .map((snap) => ({ sessionId: snap.sessionId, t: Date.parse(snap.createdAt) }));
    const derived = deriveCallCompositions(
      compositionCallsOf(usageItems, (recId) => sessionOfRecord.get(recId)),
      manifests,
      compactions,
    );
    const latest = manifests.reduce((a, b) =>
      b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.seq > a.seq) ? b : a,
    );
    const rail = {
      manifest: latest,
      anchor: derived.anchors.get(latest.id),
      sessions: new Set(manifests.map((m) => m.sessionId)).size,
    };
    return { byCall: derived.byCall, rail };
  }, [usageItems, manifests, sessionLogs, contextData]);

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

  // Steering reaches any assignee (`canSteerTask`). A finished task gets the
  // follow-up box instead.
  const canSteer = steerGate.supported && steeringEnabled && canSteerTask(task);

  const isFailed = task.status === "failed";
  const hasSessionLogs = sessionLogs && sessionLogs.length > 0;
  const hasOutput = !!task.output;
  const hasAttachments = !!(task.attachments && task.attachments.length > 0);
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

  // Who, where from, when, cost, context and the technical ids. The
  // wide layout shows it as the right rail, the narrow one in its Details tab.
  const detailsRail = (
    <TaskDetailsRail
      task={task}
      agentName={agentName}
      requestedByName={requestedByUserName}
      costs={costs}
      costsLoading={costsLoading}
      context={contextData}
      contextLoading={contextLoading}
      callUsage={callUsage}
      composition={compositions?.rail}
    />
  );

  // A failed task's error, always open, with Retry and Get help. "Failed
  // after" names the rail's run time, so the two never disagree.
  const failureCallout = isFailed ? (
    <TaskFailureCallout model={actions} duration={taskRunTime(task, costs)} />
  ) : null;

  // THE MESSAGE BOX, one per layout tree, on the one draft. A finished task
  // follows up: a child task for the same agent (a Slack task answers in the
  // same thread). A live task steers. Any other task has no box.
  const composerProps = isTerminal
    ? {
        targetTask: task,
        canSteer: false,
        followUpAgentId: task.agentId ?? undefined,
        routeLabel: task.agentId ? `Routes to ${agentName ?? "the same agent"}` : undefined,
        value: draft,
        onValueChange: setDraft,
        onCreated: announceFollowUp,
        fullWidth: true,
        className: "px-0 pt-0 pb-0",
      }
    : canSteer
      ? {
          targetTask: task,
          canSteer: true,
          followUpAgentId: task.agentId ?? undefined,
          value: draft,
          onValueChange: setDraft,
          fullWidth: true,
          className: "px-0 pt-0 pb-0",
        }
      : null;

  // THE OUTCOME, the transcript's last message, as a chat app's final reply:
  // the answer as plain text (clamped, with "Show more"), then a failed task's
  // error with Retry and Get help.
  const answer = hasOutput ? (
    <div data-slot="transcript-outcome" className="min-w-0 px-1">
      <ShowMore>
        <StructuredOutputContent
          citations={task.citations}
          raw={task.output ?? ""}
          maxH=""
          taskIds={knownTaskIds}
        />
      </ShowMore>
    </div>
  ) : null;
  const outcome =
    answer || failureCallout ? (
      <>
        {answer}
        {failureCallout}
      </>
    ) : null;

  // THE SIDE PANEL's tabs (the narrow layout's tabs after Transcript).
  // Tree: where the task came from and what it delegated, with live status.
  // Its own container: the 320 px panel hides the rows' agent column.
  const treeContent = (
    <div className="@container flex flex-col gap-3">
      {task.parentTaskId ? (
        <Link
          to={`/tasks/${task.parentTaskId}`}
          className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5 shrink-0" />
          <span className="truncate">
            Started by{" "}
            <span className="font-mono text-primary">#{task.parentTaskId.slice(0, 8)}</span>
          </span>
        </Link>
      ) : null}
      {spawnedTasks}
      {!task.parentTaskId && spawned.length === 0 ? (
        <p className="text-xs text-muted-foreground">No parent task and no delegated tasks.</p>
      ) : null}
    </div>
  );
  // Files: what the task attached.
  const filesContent = hasAttachments ? (
    <TaskAttachmentsSection taskId={task.id} attachments={task.attachments} variant="plain" />
  ) : (
    <p className="text-xs text-muted-foreground">No files.</p>
  );
  const sidePanelTabs = [
    { value: "details", label: "Details", content: detailsRail },
    { value: "tree", label: "Tree", content: treeContent },
    { value: "files", label: "Files", content: filesContent },
  ] as const;

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

  // The waiting line: what the task waits for, as plain text.
  const waitingLine = (
    <div className="flex shrink-0 items-center gap-2 px-1">
      <TaskStatusIcon status={task.status} />
      <p className="text-sm text-muted-foreground">{waiting}</p>
    </div>
  );

  // The raw log: every event, with its own toolbar. Each layout passes its
  // scroller as `scrollElement` (the wide column, the narrow root), so the
  // log flows in the page scroller with no scroller of its own. `null` until
  // the scroller mounts. The narrow layout asks for 44 px toolbar controls.
  const renderRawLog = (scrollElement: HTMLElement | null, touchTargets: boolean) =>
    showLogViewer ? (
      <CallCompositionContext.Provider value={compositions?.byCall ?? NO_CALL_COMPOSITIONS}>
        <SessionLogViewer
          logs={sessionLogs ?? []}
          compactionSnapshots={contextData?.snapshots}
          isRunning={taskIsRunning(task.status)}
          steeringMessages={steeringForViewer}
          scrollElement={scrollElement}
          touchTargets={touchTargets}
          status={task.status}
        />
      </CallCompositionContext.Provider>
    ) : sessionLogsLoading ? (
      // Do not claim "no session log" before the read answers.
      <Skeleton className="h-12 w-full shrink-0 rounded-lg" />
    ) : (
      waitingLine
    );

  // The transcript: the same renderer as the Sessions task sheet, with the
  // outcome as its last message (after the waiting line of a run with no rows).
  const hasRows = transcriptRows.length > 0;
  const renderTranscript = (scrollElement: HTMLElement | null) => (
    <>
      <TaskTranscript
        key={task.id}
        task={task}
        rows={transcriptRows}
        scroller={scrollElement}
        outcome={hasRows ? outcome : null}
        outcomeText={task.output ?? undefined}
      />
      {hasRows ? null : (
        <>
          {sessionLogsLoading ? (
            <Skeleton className="h-12 w-full shrink-0 rounded-lg" />
          ) : (
            waitingLine
          )}
          {outcome}
        </>
      )}
    </>
  );

  const renderSessionLogs = (scrollElement: HTMLElement | null, touchTargets = false) => (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">
          {logMode === "raw" ? "Raw log" : "Transcript"}
        </h2>
        <SegmentedControl
          size="sm"
          aria-label="Log view"
          value={logMode}
          onValueChange={setLogMode}
          options={LOG_MODE_OPTIONS}
          // Touch: 44 px options inside the control's border and padding.
          className={cn(touchTargets && "h-12.5")}
        />
      </div>
      {logMode === "raw" ? (
        <>
          {renderRawLog(scrollElement, touchTargets)}
          {outcome}
        </>
      ) : (
        renderTranscript(scrollElement)
      )}
      <TaskCitationsSection output={task.output ?? ""} citations={task.citations ?? []} />
    </>
  );

  // The wide layout's live message box: it steers the task, as before. It
  // sits under the log, folded or open.
  const steerComposer =
    composerProps && !isTerminal ? (
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
        <TaskComposer {...composerProps} />
      </CollapsibleComposerDock>
    ) : null;

  const headerTitle = taskListTitle(task);
  // The server records the model it resolved when the task was claimed
  // (`resolvedModel`, with the layer in `modelSource`). Older tasks and
  // unclaimed ones fall back to the requested `model`, then to whatever the
  // session_costs entries report.
  const displayModel = taskDisplayModel(task) ?? costs?.[0]?.model;
  const displayEffort = taskDisplayEffort(task);
  const creatorName =
    task.creatorAgentId && task.creatorAgentId !== task.agentId
      ? (agentNames.get(task.creatorAgentId) ?? null)
      : null;

  // HERO CHIPS: status, model (with the effort icon when the task records one)
  // and agent, then the tags as plain text. The harness, type, priority and
  // source are in Technical details. In the wide layout the model chip takes
  // focus and its tooltip has the exact model id. The narrow layout shows the
  // plain chip: a 44 px focus target would not fit the chip row, a hover
  // tooltip would cover the tabs under it, and Details lists the model id.
  const modelBadge = displayModel ? (
    <ModelEffortLabel model={displayModel} effort={displayEffort} />
  ) : task.modelTier ? (
    <>
      {modelTierLabel(task.modelTier)} tier
      <EffortMark effort={displayEffort} className="text-muted-foreground" />
    </>
  ) : null;
  // `outline-none`: the chips show the Badge's amber focus ring only, not the
  // browser outline on top of it.
  const modelChipClass = "h-6 max-w-full min-w-0 gap-1.5 px-2 outline-none";
  const wideModelChip = displayModel ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" tabIndex={0} className={modelChipClass}>
          {modelBadge}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="text-left">
        <div className="font-mono">{displayModel}</div>
        {describeModelResolution(task).map((line) => (
          <div key={line}>{line}</div>
        ))}
        {displayEffort ? <div>Effort: {REASONING_EFFORT_LABEL[displayEffort]}</div> : null}
      </TooltipContent>
    </Tooltip>
  ) : modelBadge ? (
    <Badge variant="outline" className={modelChipClass}>
      {modelBadge}
    </Badge>
  ) : null;
  const narrowModelChip = modelBadge ? (
    <Badge variant="outline" className={modelChipClass}>
      {modelBadge}
    </Badge>
  ) : null;
  const agentChip = task.agentId ? (
    <Badge variant="outline" asChild className="h-6 max-w-full gap-1.5 pr-2 pl-0.5 outline-none">
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
  const renderTagsLine = (className?: string) =>
    task.tags && task.tags.length > 0 ? (
      <span
        className={cn(
          "ml-1 inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground",
          className,
        )}
      >
        <Tag aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only">Tags: </span>
        <span className="min-w-0 truncate">{task.tags.join(", ")}</span>
      </span>
    ) : null;
  const sourceLine = (
    <TaskSourceLine task={task} requestedByName={requestedByUserName} creatorName={creatorName} />
  );

  // Folds the details panel away (and back), next to the app sidebar's own
  // fold. The pick persists per browser.
  const detailsToggle = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={detailsCollapsed ? "Show side panel" : "Hide side panel"}
          aria-pressed={!detailsCollapsed}
          onClick={() => setDetailsCollapsed(!detailsCollapsed)}
          className="text-muted-foreground hover:text-foreground"
        >
          {detailsCollapsed ? <PanelRightOpen /> : <PanelRightClose />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {detailsCollapsed ? "Show side panel" : "Hide side panel"}
      </TooltipContent>
    </Tooltip>
  );

  // With the side panel folded, the column takes the chat width the Sessions
  // page uses (T3 Code's, see `CHAT_COLUMN`).
  const readingWidth = detailsCollapsed ? CHAT_COLUMN : undefined;

  // WIDE HERO: the title, with the actions and the details fold right of it,
  // then one row: where the task came from on the left, the chips on the
  // right. A narrow column wraps the chips under the source line.
  const wideHero = (
    <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-2.5">
      {/* The page's one heading. The breadcrumb truncates the title (and
          collapses to a few characters on a phone), so it cannot carry it. */}
      <div className="min-w-0">
        <TaskHeading title={headerTitle} />
      </div>
      <div className="flex items-start justify-end gap-1">
        <TaskActions model={actions} className="justify-end" />
        {detailsToggle}
      </div>
      <div
        data-slot="task-meta-row"
        className="col-span-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
      >
        <div className="min-w-0">{sourceLine}</div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {renderTagsLine()}
          <StatusBadge status={task.status} size="md" />
          {wideModelChip}
          {agentChip}
        </div>
      </div>
    </div>
  );

  // NARROW HERO: compact, and it scrolls away. A back arrow and the "..."
  // menu (every action but the message box), then the title, the source
  // line with status and model, and the tags. The agent is in Details.
  const narrowHero = (
    <div className="flex flex-col gap-1 pb-3">
      <div className="-mx-2 flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          asChild
          className="h-11 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
        >
          <Link to="/tasks">
            <ArrowLeft />
            Tasks
          </Link>
        </Button>
        <TaskActionsMenu model={actions} />
      </div>
      <TaskHeading title={headerTitle} />
      {/* One row: the source line left, status and model right. A phone too
          narrow for both wraps the chips under it. */}
      <div
        data-slot="task-meta-row"
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
      >
        <div className="min-w-0 max-w-full">{sourceLine}</div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <StatusBadge status={task.status} size="md" />
          {narrowModelChip}
        </div>
      </div>
      {renderTagsLine("ml-0")}
    </div>
  );

  return (
    // The layout follows the page's own width, not the window's: a docked
    // context panel or an open sidebar can leave a wide window with a narrow
    // page.
    <div className="@container flex flex-col flex-1 min-h-0">
      {isFailed ? (
        <TaskFailureHelpDialog
          task={task}
          open={helpOpen}
          onOpenChange={setHelpOpen}
          returnFocus={helpOpener}
        />
      ) : null}

      {/* Narrow (under 60rem of page width): one scroller from under the app
          header down to the message box, which is pinned under it (it bleeds
          into <main>'s padding). The hero scrolls away and the tabs stick to
          the top. The log flows in this scroller: the tabs' height goes to it
          as a CSS variable, so its toolbar sticks under the tabs. */}
      <div className={cn("@min-[60rem]:hidden flex min-h-0 flex-1 flex-col", MAIN_BLEED)}>
        <div
          ref={setNarrowScroller}
          style={{ "--log-sticky-top": `${narrowTabsHeight}px` } as CSSProperties}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]"
        >
          <div ref={narrowHeroRef} className={MAIN_GUTTER_X}>
            {narrowHero}
          </div>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 gap-0">
            <div
              ref={narrowTabsRef}
              className={cn(
                "sticky top-0 z-20 border-b border-border-subtle bg-background py-2",
                MAIN_GUTTER_X,
              )}
            >
              <TabsList className="w-full group-data-[orientation=horizontal]/tabs:h-auto">
                <TabsTrigger value="logs" className="h-11">
                  Transcript
                </TabsTrigger>
                {sidePanelTabs.map((tab) => (
                  <TabsTrigger key={tab.value} value={tab.value} className="h-11">
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            {/* Each panel is a Tab stop (Radix), so it shows the focus ring. */}
            <TabsContent
              value="logs"
              className={cn("flex flex-col gap-3 py-3", MAIN_GUTTER_X, PANEL_FOCUS_RING)}
            >
              {renderSessionLogs(narrowScroller, true)}
            </TabsContent>
            {sidePanelTabs.map((tab) => (
              <TabsContent
                key={tab.value}
                value={tab.value}
                className={cn("py-3", MAIN_GUTTER_X, PANEL_FOCUS_RING)}
              >
                {tab.content}
              </TabsContent>
            ))}
          </Tabs>
        </div>
        {composerProps ? (
          // Pinned under the scroller, on every tab. `env(safe-area-inset-bottom)`
          // keeps the box above the home indicator when the page runs edge to edge.
          <div
            ref={narrowBarRef}
            className={cn(
              "shrink-0 border-t border-border bg-background pt-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]",
              MAIN_GUTTER_X,
            )}
          >
            <TaskComposer {...composerProps} bar />
          </div>
        ) : null}
      </div>

      {/* Wide: a center column and the tabbed side panel. The grid bleeds
          into <main>'s vertical padding, so the column runs from under the app
          header down to the window edge. */}
      <div
        className={cn(
          "hidden @min-[60rem]:grid flex-1 min-h-0",
          detailsCollapsed ? "grid-cols-[minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)_320px]",
          MAIN_BLEED_Y,
        )}
      >
        <section className="flex min-h-0 flex-col">
          {/* Only the transcript scrolls. Its toolbar sticks under the bar. */}
          <div
            ref={centerScrollerRef}
            style={{ "--log-sticky-top": STICKY_BAR_HEIGHT } as CSSProperties}
            className="relative min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
          >
            <TaskStickyBar
              visible={heroScrolledPast}
              title={headerTitle}
              status={task.status}
              model={displayModel}
              effort={displayEffort}
              action={<TaskPrimaryAction model={actions} />}
              onTitleClick={() => scrollToTop(centerScroller)}
            />
            <div className={cn("flex flex-col gap-3 pt-6 pr-6 pb-3", readingWidth)}>
              <div className="pb-2">
                {wideHero}
                <div ref={heroEndRef} aria-hidden className="h-px" />
              </div>
              <Separator />

              {/* THE TRANSCRIPT is the main view: the prompt, the run, then the
                  outcome as its last message, as in a chat. */}
              {renderSessionLogs(centerScroller)}
            </div>
          </div>
          {composerProps ? (
            // THE MESSAGE BOX, pinned under the scroller: it steers a live
            // task and follows up a finished one.
            <div className={cn("shrink-0 bg-background pt-2 pr-6 pb-3", readingWidth)}>
              {isTerminal ? (
                <div ref={wideFollowUpBoxRef}>
                  <TaskComposer {...composerProps} />
                </div>
              ) : (
                steerComposer
              )}
            </div>
          ) : null}
        </section>

        {detailsCollapsed ? null : (
          <aside
            aria-label="Task side panel"
            className="flex min-h-0 flex-col border-l border-border"
          >
            <Tabs
              value={sidePanelTab}
              onValueChange={setSidePanelTab}
              className="flex min-h-0 flex-1 flex-col gap-0"
            >
              <div className="shrink-0 border-b border-border-subtle px-4 py-2">
                <TabsList className="w-full">
                  {sidePanelTabs.map((tab) => (
                    <TabsTrigger key={tab.value} value={tab.value}>
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              {sidePanelTabs.map((tab) => (
                <TabsContent
                  key={tab.value}
                  value={tab.value}
                  className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", PANEL_FOCUS_RING)}
                >
                  {tab.content}
                </TabsContent>
              ))}
            </Tabs>
          </aside>
        )}
      </div>
    </div>
  );
}
