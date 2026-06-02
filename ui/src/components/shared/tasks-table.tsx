import type { ColDef, RowClickedEvent } from "ag-grid-community";
import {
  Activity,
  Calendar,
  ChevronDown,
  Code2,
  FlaskConical,
  GitBranch,
  Github,
  Gitlab,
  GitPullRequest,
  Globe,
  Inbox,
  Layout,
  LineChart,
  ListChecks,
  ListTodo,
  Mail,
  MessageCircleReply,
  MessagesSquare,
  Plug,
  Search,
  Settings2,
  ShieldCheck,
  UserCheck,
  Webhook,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useUsers } from "@/api/hooks/use-users";
import type { AgentTask, User } from "@/api/types";
import { AgentAvatar } from "@/components/shared/agent-avatar";
import { DataGrid } from "@/components/shared/data-grid";
import { MarkdownView } from "@/components/shared/markdown-view";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { findKnownModel } from "@/lib/agent-runtime-models";
import { formatCost } from "@/lib/cost-format";
import { cn, formatElapsed, formatSmartTime } from "@/lib/utils";

// ─── Column model ────────────────────────────────────────────────────────────

export type TasksTableColumnId =
  | "description"
  | "status"
  | "source"
  | "cost"
  | "model"
  | "agent"
  | "user"
  | "elapsed"
  | "created"
  | "type"
  | "deps"
  | "tags";

// Columns the user can hide via the visibility dropdown. Description+Status
// stay pinned so the table always has an anchor.
//
// `user` is feature-gated on swarm ≥ 1.81.0 (the `requestedByUserId` column
// landed in Phase 1 of the identity work; this table surfaces it once the
// connected server has the People page + composeUser pipeline). When the
// server is older, the table strips the column AND the menu omits the entry.
export const TOGGLEABLE_COLUMNS: { id: TasksTableColumnId; label: string }[] = [
  { id: "source", label: "Source" },
  { id: "cost", label: "Cost" },
  { id: "model", label: "Model" },
  { id: "agent", label: "Agent" },
  { id: "user", label: "Requested by" },
  { id: "elapsed", label: "Elapsed" },
  { id: "created", label: "Created" },
  { id: "type", label: "Type" },
  { id: "deps", label: "Deps" },
  { id: "tags", label: "Tags" },
];

const ALWAYS_VISIBLE: TasksTableColumnId[] = ["description", "status"];
const ALL_COLUMN_IDS: TasksTableColumnId[] = [
  ...ALWAYS_VISIBLE,
  ...TOGGLEABLE_COLUMNS.map((column) => column.id),
];

// Defaults applied on first mount (when no localStorage entry exists). Deps
// and Tags are useful but visually noisy in the default density.
const DEFAULT_HIDDEN: TasksTableColumnId[] = ["deps", "tags"];

// Em-dash used for empty cells across every renderer so the table reads
// consistently instead of mixing empty cells, "—", and "not set".
const DASH = <span className="text-muted-foreground">—</span>;

// ─── Source pill icons ───────────────────────────────────────────────────────

type IconCmp = ComponentType<SVGProps<SVGSVGElement>>;

const SOURCE_ICON: Record<string, IconCmp> = {
  mcp: Plug,
  slack: MessagesSquare,
  api: Webhook,
  ui: Layout,
  github: Github,
  gitlab: Gitlab,
  agentmail: Mail,
  system: Settings2,
  schedule: Calendar,
  workflow: Workflow,
  linear: Code2,
  jira: Globe,
};

function SourcePill({ value }: { value: string | undefined }) {
  if (!value) return DASH;
  const Icon = SOURCE_ICON[value];
  return (
    <Badge variant="outline" size="tag" className="gap-1">
      {Icon ? <Icon className="h-2.5 w-2.5 shrink-0" /> : null}
      {value}
    </Badge>
  );
}

// ─── Cell renderers ──────────────────────────────────────────────────────────

// Override the default tooltip "tip" surface (bg-foreground/text-background) with
// the standard popover surface so markdown — and especially Streamdown's inline
// code + fenced code blocks — render against theme-aware tokens instead of
// fighting the dark tip background.
// Fixed width (not max-width): the underlying TooltipContent is `w-fit`, so
// `max-w-xl` collapses when the body's intrinsic width is auto (Monaco's
// `width: 100%` resolves to 0 in that case).
const MARKDOWN_TOOLTIP_CLASS =
  "w-[36rem] break-words text-left !bg-popover !text-popover-foreground border border-border shadow-md p-3";

function TooltipMarkdown({ text }: { text: string }) {
  return (
    <div className="max-h-96 overflow-y-auto text-sm leading-relaxed">
      <MarkdownView text={text} />
    </div>
  );
}

function StatusCell({ task }: { task: AgentTask }) {
  const tooltip =
    task.status === "failed"
      ? task.failureReason
      : task.status === "completed"
        ? task.output
        : task.progress;

  const badge = <StatusBadge status={task.status} />;
  if (!tooltip) return badge;

  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <span className="inline-flex">{badge}</span>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className={MARKDOWN_TOOLTIP_CLASS}>
        <TooltipMarkdown text={tooltip} />
      </TooltipContent>
    </Tooltip>
  );
}

function DescriptionCell({ value }: { value: string | undefined }) {
  const text = value ?? "";
  if (!text) return DASH;
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <span className="block truncate">{text}</span>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className={MARKDOWN_TOOLTIP_CLASS}>
        <TooltipMarkdown text={text} />
      </TooltipContent>
    </Tooltip>
  );
}

function ModelCell({ value }: { value: string | undefined }) {
  if (!value) return DASH;
  const known = findKnownModel(value);
  return (
    <span className="inline-flex items-center gap-1.5">
      <ProviderIcon provider={known?.providerId} className="h-3.5 w-3.5" />
      <span className="truncate">{known?.label ?? value}</span>
    </span>
  );
}

function CostCell({ value }: { value: number | null | undefined }) {
  if (value == null) return DASH;
  const precision = value > 0 && value < 1 ? 4 : "auto";
  return <span className="font-mono text-xs tabular-nums">{formatCost(value, { precision })}</span>;
}

function AgentCell({
  agentId,
  agentName,
}: {
  agentId: string | undefined | null;
  agentName: string | undefined;
}) {
  if (!agentId) return <span className="text-xs text-muted-foreground">Unassigned</span>;
  const label = agentName ?? `${agentId.slice(0, 8)}…`;
  return (
    <Link
      to={`/agents/${agentId}`}
      className="inline-flex items-center gap-1.5 text-foreground hover:underline"
    >
      <AgentAvatar agentId={agentId} agentName={label} size="xs" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

/**
 * "Requested by" cell — resolves `requestedByUserId` against the parent's
 * `userById` map. Falls back name → email → truncated id → em-dash, in that
 * order, so the cell always renders something legible even mid-merge or before
 * the users query lands.
 */
function UserCell({
  userId,
  userById,
}: {
  userId: string | undefined | null;
  userById: Map<string, User> | undefined;
}) {
  if (!userId) return DASH;
  const user = userById?.get(userId);
  const label = user?.name?.trim() || user?.email?.trim() || `${userId.slice(0, 8)}…`;
  return (
    <Link
      to={`/people/${userId}`}
      className="inline-flex items-center gap-1.5 text-foreground hover:underline min-w-0"
    >
      <UserCheck className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function DepsCell({ value }: { value: string[] | undefined }) {
  if (!value || value.length === 0) return DASH;
  return (
    <div className="flex items-center gap-1 text-muted-foreground">
      <GitBranch className="h-3 w-3 shrink-0" />
      <span className="font-mono text-[10px]">{value.length}</span>
    </div>
  );
}

function TagsCell({ value }: { value: string[] | undefined }) {
  const tags = value ?? [];
  if (tags.length === 0) return DASH;
  return (
    <div className="flex items-center gap-1">
      {tags.slice(0, 2).map((tag) => (
        <Badge key={tag} variant="outline" size="tag" className="shrink-0">
          {tag}
        </Badge>
      ))}
      {tags.length > 2 ? (
        <span className="shrink-0 font-medium text-[9px] text-muted-foreground">
          +{tags.length - 2}
        </span>
      ) : null}
    </div>
  );
}

// Catalog of known task types. Anything not in this map renders as a plain
// outline pill with the raw value (so future types degrade gracefully).
const TASK_TYPE_META: Record<string, { label: string; icon: IconCmp }> = {
  // Inbound integrations
  "agentmail-message": { label: "AgentMail message", icon: Mail },
  "agentmail-reply": { label: "AgentMail reply", icon: Mail },
  "github-comment": { label: "GitHub comment", icon: Github },
  "github-issue": { label: "GitHub issue", icon: Github },
  "github-pr": { label: "GitHub PR", icon: GitPullRequest },
  "github-review": { label: "GitHub review", icon: Github },
  "gitlab-ci": { label: "GitLab CI", icon: Gitlab },
  "gitlab-comment": { label: "GitLab comment", icon: Gitlab },
  "gitlab-issue": { label: "GitLab issue", icon: Gitlab },
  "gitlab-mr": { label: "GitLab MR", icon: GitPullRequest },
  "jira-issue": { label: "Jira issue", icon: Globe },
  "linear-issue": { label: "Linear issue", icon: Code2 },
  // System
  heartbeat: { label: "Heartbeat", icon: Activity },
  "heartbeat-checklist": { label: "Heartbeat checklist", icon: Activity },
  "boot-triage": { label: "Boot triage", icon: Activity },
  // Workflow shapes
  inbox: { label: "Inbox", icon: Inbox },
  "skill-approval": { label: "Skill approval", icon: ShieldCheck },
  maintenance: { label: "Maintenance", icon: Wrench },
  monitoring: { label: "Monitoring", icon: LineChart },
  research: { label: "Research", icon: Search },
  test: { label: "Test", icon: FlaskConical },
  "full-test": { label: "Full test", icon: FlaskConical },
  "follow-up": { label: "Follow-up", icon: MessageCircleReply },
  "hitl-follow-up": { label: "Human follow-up", icon: UserCheck },
  "quick-fix": { label: "Quick fix", icon: Zap },
  comprehensive: { label: "Comprehensive", icon: ListChecks },
  task: { label: "Task", icon: ListTodo },
};

function TypeCell({ value }: { value: string | undefined }) {
  if (!value) return DASH;
  const meta = TASK_TYPE_META[value];
  const Icon = meta?.icon;
  return (
    <Badge variant="outline" size="tag" className="gap-1">
      {Icon ? <Icon className="h-2.5 w-2.5 shrink-0" /> : null}
      {meta?.label ?? value}
    </Badge>
  );
}

// ─── Column visibility state (lifted out so parents can place the menu) ──────

function toColumnIds(value: unknown): TasksTableColumnId[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is TasksTableColumnId => typeof x === "string");
}

function loadHidden(
  storageKey: string | undefined,
  defaultHiddenForNewColumns: TasksTableColumnId[],
): Set<TasksTableColumnId> | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`tasks-table:hidden:${storageKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const hidden = new Set(toColumnIds(parsed));
      for (const id of defaultHiddenForNewColumns) hidden.add(id);
      return hidden;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const data = parsed as { hidden?: unknown; known?: unknown };
    const hidden = new Set(toColumnIds(data.hidden));
    const known = new Set(toColumnIds(data.known));
    for (const id of defaultHiddenForNewColumns) {
      if (!known.has(id)) hidden.add(id);
    }
    return hidden;
  } catch {
    return null;
  }
}

function saveHidden(storageKey: string | undefined, hidden: Set<TasksTableColumnId>) {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `tasks-table:hidden:${storageKey}`,
      JSON.stringify({ hidden: Array.from(hidden), known: ALL_COLUMN_IDS }),
    );
  } catch {
    // Quota / private-mode failures: silently keep state in memory only.
  }
}

export interface TasksColumnsState {
  isHidden: (id: TasksTableColumnId) => boolean;
  /** Caller-forced columns: shown in menu as "locked". */
  forcedHidden: Set<TasksTableColumnId>;
  /** Version-gated columns: omitted from menu entirely. */
  gateHidden: Set<TasksTableColumnId>;
  toggle: (id: TasksTableColumnId, next: boolean) => void;
}

export function useTasksColumns({
  storageKey,
  hiddenColumns,
  defaultHiddenColumns = DEFAULT_HIDDEN,
  defaultHiddenForNewColumns = [],
}: {
  storageKey?: string;
  hiddenColumns?: TasksTableColumnId[];
  defaultHiddenColumns?: TasksTableColumnId[];
  defaultHiddenForNewColumns?: TasksTableColumnId[];
}): TasksColumnsState {
  // Soft-gate the "Requested by" column on the swarm exposing the People
  // surface. When the server is older (or unknown), drop the column AND its
  // menu entry so users don't see a checkbox for a column that can never
  // resolve. Mirrors the soft-degrade pattern used by other identity-aware
  // surfaces (`useFeatureGate("1.76.0")` in CurrentUserContext).
  const { supported: userColumnSupported } = useFeatureGate("1.81.0");
  const forcedHidden = useMemo(() => new Set(hiddenColumns ?? []), [hiddenColumns]);
  const gateHidden = useMemo<Set<TasksTableColumnId>>(
    () => (userColumnSupported ? new Set() : new Set(["user"])),
    [userColumnSupported],
  );
  const [userHidden, setUserHidden] = useState<Set<TasksTableColumnId>>(() => {
    const saved = loadHidden(storageKey, defaultHiddenForNewColumns);
    return saved ?? new Set(defaultHiddenColumns);
  });

  useEffect(() => {
    saveHidden(storageKey, userHidden);
  }, [storageKey, userHidden]);

  const isHidden = useCallback(
    (id: TasksTableColumnId) => forcedHidden.has(id) || gateHidden.has(id) || userHidden.has(id),
    [forcedHidden, gateHidden, userHidden],
  );

  const toggle = useCallback((id: TasksTableColumnId, next: boolean) => {
    setUserHidden((prev) => {
      const out = new Set(prev);
      if (next) out.delete(id);
      else out.add(id);
      return out;
    });
  }, []);

  return { isHidden, forcedHidden, gateHidden, toggle };
}

// ─── Columns menu (rendered wherever the parent wants) ───────────────────────

export function TasksColumnsMenu({
  state,
  trigger,
}: {
  state: TasksColumnsState;
  trigger?: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" />
            Columns
            <ChevronDown className="h-3 w-3 opacity-60" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuLabel className="text-xs">Show columns</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ALWAYS_VISIBLE.map((id) => (
          <DropdownMenuCheckboxItem
            key={id}
            checked
            disabled
            className={cn("capitalize opacity-60")}
            onCheckedChange={() => {}}
          >
            {id}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        {TOGGLEABLE_COLUMNS.filter(({ id }) => !state.gateHidden.has(id)).map(({ id, label }) => {
          const forced = state.forcedHidden.has(id);
          return (
            <DropdownMenuCheckboxItem
              key={id}
              checked={!state.isHidden(id)}
              disabled={forced}
              onCheckedChange={(checked) => state.toggle(id, Boolean(checked))}
            >
              {label}
              {forced ? (
                <span className="ml-auto text-[10px] text-muted-foreground">locked</span>
              ) : null}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Public table ────────────────────────────────────────────────────────────

export interface TasksTableProps {
  rowData: AgentTask[] | undefined;
  loading?: boolean;
  onRowClicked?: (e: RowClickedEvent<AgentTask>) => void;
  /** Resolves agentId → display name. Cheap lookup the parent already has. */
  agentNameById?: Map<string, string>;
  /** Column visibility state. Create with `useTasksColumns(...)` in the parent. */
  columns: TasksColumnsState;
  emptyMessage?: string;
  /**
   * AG Grid layout. Default `"normal"` fills the parent's height (parent must
   * be flex-1 min-h-0). Use `"autoHeight"` when the table lives inside a
   * scrolling page so it sizes to its content.
   */
  domLayout?: "normal" | "autoHeight";
  /**
   * AG Grid's built-in client-side pager. Defaults to `true`. Set `false` when
   * the parent already does server-side offset pagination (e.g. the Tasks
   * page) — otherwise the two pagers stack and AG Grid silently caps the view
   * at whatever the server returned for the current page.
   */
  pagination?: boolean;
}

export function TasksTable({
  rowData,
  loading,
  onRowClicked,
  agentNameById,
  columns,
  emptyMessage = "No tasks found",
  domLayout,
  pagination,
}: TasksTableProps) {
  // Build a `userId → User` lookup for the "Requested by" column. We skip the
  // network call entirely on swarms that don't support the column — the
  // gate-hidden set already filters the column out of `columnDefs`, so the
  // map would be wasted work. `useUsers()` itself is also gated server-side at
  // ≥ 1.76.0 (older servers 404), but the explicit `enabled` guard keeps an
  // older server quiet in the network tab.
  const userColumnVisible = !columns.isHidden("user");
  const { data: usersData } = useUsers();
  const userById = useMemo<Map<string, User> | undefined>(() => {
    if (!userColumnVisible) return undefined;
    if (!usersData) return undefined;
    const m = new Map<string, User>();
    for (const u of usersData) m.set(u.id, u);
    return m;
  }, [userColumnVisible, usersData]);

  const columnDefs = useMemo<ColDef<AgentTask>[]>(() => {
    // DataGrid calls `sizeColumnsToFit()` on grid ready, which by default
    // proportionally resizes every column — including fixed ones — to fill
    // the viewport. We want the opposite: Description absorbs leftover width
    // via `flex: 1`, and every other column locks at its declared width via
    // `suppressSizeToFit: true`. Net effect: on a wide table, only Description
    // grows; on a narrow one, only Description shrinks (down to its minWidth)
    // and the others stay put (the grid scrolls horizontally instead).
    const fixed = { suppressSizeToFit: true } as const;
    const all: Array<ColDef<AgentTask> & { _id: TasksTableColumnId }> = [
      {
        _id: "description",
        field: "task",
        headerName: "Description",
        flex: 1,
        minWidth: 240,
        cellRenderer: (p: { value: string }) => <DescriptionCell value={p.value} />,
      },
      {
        _id: "status",
        field: "status",
        headerName: "Status",
        width: 130,
        ...fixed,
        cellRenderer: (p: { data?: AgentTask }) => (p.data ? <StatusCell task={p.data} /> : null),
      },
      {
        _id: "source",
        field: "source",
        headerName: "Source",
        width: 110,
        ...fixed,
        cellRenderer: (p: { value: string | undefined }) => <SourcePill value={p.value} />,
      },
      {
        _id: "cost",
        field: "totalCostUsd",
        headerName: "Cost",
        width: 105,
        ...fixed,
        cellClass: "ag-right-aligned-cell",
        headerClass: "ag-right-aligned-header",
        cellRenderer: (p: { value: number | null | undefined }) => <CostCell value={p.value} />,
      },
      {
        _id: "model",
        field: "model",
        headerName: "Model",
        width: 180,
        ...fixed,
        cellRenderer: (p: { value: string | undefined }) => <ModelCell value={p.value} />,
      },
      {
        _id: "agent",
        field: "agentId",
        headerName: "Agent",
        width: 170,
        ...fixed,
        valueGetter: (params) => params.data?.agentId ?? "",
        cellRenderer: (p: { value: string }) => (
          <AgentCell agentId={p.value} agentName={agentNameById?.get(p.value)} />
        ),
      },
      {
        _id: "user",
        headerName: "Requested by",
        width: 180,
        ...fixed,
        // Sort by resolved display name (name → email → id) so the column
        // alphabetizes the way it reads, not by opaque user id.
        valueGetter: (params) => {
          const id = params.data?.requestedByUserId;
          if (!id) return "";
          const user = userById?.get(id);
          return user?.name?.trim() || user?.email?.trim() || id;
        },
        cellRenderer: (p: { data?: AgentTask }) => (
          <UserCell userId={p.data?.requestedByUserId} userById={userById} />
        ),
      },
      {
        _id: "elapsed",
        headerName: "Elapsed",
        width: 100,
        ...fixed,
        valueGetter: (params) => {
          const task = params.data;
          if (!task) return "";
          const start = task.acceptedAt ?? task.createdAt;
          const end = task.finishedAt;
          const isActive =
            !end &&
            (task.status === "in_progress" ||
              task.status === "pending" ||
              task.status === "offered");
          return isActive ? formatElapsed(start) : end ? formatElapsed(start, end) : "—";
        },
      },
      {
        _id: "created",
        field: "createdAt",
        headerName: "Created",
        width: 130,
        ...fixed,
        valueFormatter: (params) => (params.value ? formatSmartTime(params.value) : "—"),
      },
      {
        _id: "type",
        field: "taskType",
        headerName: "Type",
        width: 170,
        ...fixed,
        cellRenderer: (p: { value: string | undefined }) => <TypeCell value={p.value} />,
      },
      {
        _id: "deps",
        field: "dependsOn",
        headerName: "Deps",
        width: 80,
        ...fixed,
        sortable: false,
        cellRenderer: (p: { value: string[] | undefined }) => <DepsCell value={p.value} />,
      },
      {
        _id: "tags",
        field: "tags",
        headerName: "Tags",
        width: 200,
        ...fixed,
        sortable: false,
        cellRenderer: (p: { value: string[] | undefined }) => <TagsCell value={p.value} />,
      },
    ];

    return all.filter((c) => !columns.isHidden(c._id)).map(({ _id, ...col }) => col);
  }, [agentNameById, columns, userById]);

  return (
    <DataGrid
      rowData={rowData ?? []}
      columnDefs={columnDefs}
      onRowClicked={onRowClicked}
      loading={loading}
      emptyMessage={emptyMessage}
      domLayout={domLayout}
      pagination={pagination}
    />
  );
}

// ─── Helper for callers' onRowClicked ────────────────────────────────────────

/**
 * Wrap your row-click handler with this so clicks on links/buttons inside a
 * cell don't also trigger row navigation. AG Grid's row handler runs before
 * React's delegated onClick can `stopPropagation`, so we filter the target
 * here instead.
 */
export function ignoreRowClickFromInteractives<T>(
  handler: (e: RowClickedEvent<T>) => void,
): (e: RowClickedEvent<T>) => void {
  return (e) => {
    const target = e.event?.target;
    if (target instanceof Element && target.closest("a, button, [role='menuitem']")) return;
    handler(e);
  };
}
