import { ChevronDown, ChevronRight, CornerDownRight, Ellipsis, Home } from "lucide-react";
import { Fragment, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAgent } from "@/api/hooks/use-agents";
import { useApprovalRequest } from "@/api/hooks/use-approval-requests";
import { useApp } from "@/api/hooks/use-apps";
import { useMcpServer } from "@/api/hooks/use-mcp-servers";
import { useMetricDefinition } from "@/api/hooks/use-metric-definitions";
import { usePage } from "@/api/hooks/use-pages";
import { useRepo } from "@/api/hooks/use-repos";
import { useScheduledTask } from "@/api/hooks/use-schedules";
import { useScriptConnection } from "@/api/hooks/use-script-connections";
import { useScriptRun } from "@/api/hooks/use-script-runs";
import { useScript } from "@/api/hooks/use-scripts";
import { useSession } from "@/api/hooks/use-sessions";
import { useSkill } from "@/api/hooks/use-skills";
import { useUser } from "@/api/hooks/use-users";
import { useWorkflow, useWorkflowRun } from "@/api/hooks/use-workflows";
import type { AgentTask } from "@/api/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentUser } from "@/contexts/current-user-context";
import { INTEGRATIONS } from "@/lib/integrations-catalog";
import { shortId } from "@/lib/short-id";
import { cn, sessionDisplayTitle } from "@/lib/utils";
import {
  AncestorMenuItem,
  HiddenAncestorsMenu,
  TaskCrumbPeek,
  taskCrumbLabel,
  useAncestorFit,
} from "./task-crumbs";
import { collapseAncestors } from "./task-trail";
import { useTaskPath } from "./use-task-path";

const routeLabels: Record<string, string> = {
  dashboard: "Dashboard",
  apps: "Apps",
  agents: "Agents",
  tasks: "Tasks",
  sessions: "Sessions",
  chat: "Chat",
  services: "Services",
  schedules: "Schedules",
  workflows: "Workflows",
  "workflow-runs": "Workflow Runs",
  scripts: "Scripts",
  "script-runs": "Script Runs",
  "approval-requests": "Approvals",
  skills: "Skills",
  "mcp-servers": "MCP Servers",
  usage: "Usage",
  budgets: "Budgets",
  memory: "Memory",
  settings: "Settings",
  config: "Config",
  configuration: "Configuration",
  connections: "Connections",
  "oauth-apps": "OAuth Apps",
  secrets: "Secrets",
  repos: "Repos",
  templates: "Templates",
  history: "History",
  debug: "Debug",
  integrations: "Integrations",
  keys: "Provider keys",
  lineage: "Lineage",
  "api-keys": "Provider keys",
  pages: "Pages",
  file: "Files",
  people: "People",
  unmapped: "Unmapped",
};

/** A desktop crumb link: muted, the foreground on hover, the focus ring. */
const CRUMB_LINK =
  "rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60";

const INTEGRATION_NAME_BY_ID: Record<string, string> = Object.fromEntries(
  INTEGRATIONS.map((def) => [def.id, def.name]),
);

/** Routes that don't have their own list page — redirect breadcrumb to a parent. */
const routeRedirects: Record<string, string> = {
  "workflow-runs": "/workflows",
  "script-runs": "/scripts?tab=runs",
  "oauth-apps": "/connections?tab=oauth-apps",
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Pages use 32-char random-hex IDs (`lower(hex(randomblob(16)))`), not UUIDs.
const HEX32_REGEX = /^[0-9a-f]{32}$/i;

/** Fallback for segments without a routeLabels entry: kebab-case → Title Case
 * ("embed-test" → "Embed Test"). Keeps unknown routes readable without having
 * to register every new path here; routeLabels stays for names automatic
 * casing can't produce ("mcp-servers" → "MCP Servers", "keys" → "Provider keys"). */
function humanizeSegment(segment: string): string {
  // Malformed percent escapes ("/%", "/apps/%ZZ") make decodeURIComponent
  // throw, and the header renders OUTSIDE the route error boundary, so an
  // uncaught URIError here would take down the whole shell. Show the raw
  // segment instead.
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  return decoded
    .split("-")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

function formatSegment(segment: string, prevSegment?: string): string {
  if (routeLabels[segment]) return routeLabels[segment];
  if (prevSegment === "integrations" && INTEGRATION_NAME_BY_ID[segment]) {
    return INTEGRATION_NAME_BY_ID[segment];
  }
  if (UUID_REGEX.test(segment) || HEX32_REGEX.test(segment)) {
    return `${segment.slice(0, 8)}...`;
  }
  return humanizeSegment(segment);
}

/** True when a path segment looks like an entity id (UUID or 32-char hex). */
function isEntityId(segment: string | undefined): boolean {
  return !!segment && (UUID_REGEX.test(segment) || HEX32_REGEX.test(segment));
}

// Contextual names are NOT length-capped in JS (a 40-char cap ellipsized long
// ago before the header ran out of room — Taras). The trail takes the header's
// free space (flex-1 in AppHeader) and CSS `truncate` clips only when the
// space is actually exhausted; mobile always has the dropdown fallback.

export function Breadcrumbs() {
  const location = useLocation();
  const pathSegments = location.pathname.split("/").filter(Boolean);
  // Comb (`/file/~/<org>/<drive>/<path>`) draws its own path trail in the page.
  const segments = pathSegments[0] === "file" ? pathSegments.slice(0, 1) : pathSegments;
  // Home shows the greeting in the breadcrumb slot (there is no trail to
  // draw and no in-page h1 anymore). Called before the early return so hook
  // order stays stable across routes.
  const { user } = useCurrentUser();

  // Detail routes (/<parent>/:id[/...]) get a contextual leaf name fetched
  // from the matching single-entity hook instead of the truncated raw id.
  // The id segment is always `segments[1]` under a known `segments[0]`
  // parent. We compute one id-or-empty value per entity type and call every
  // hook unconditionally (empty string → query disabled) so hook order stays
  // stable across renders (React rules of hooks).
  const parent = segments[0];
  const detailId =
    segments.length >= 2 && isEntityId(segments[1]) ? (segments[1] as string) : undefined;
  const idFor = (route: string): string => (parent === route && detailId ? detailId : "");

  // `usePage` / `useUser` / `useSession` accept `string | undefined`; the rest
  // accept `string` and disable themselves on a falsy id. Pass `""` uniformly.
  const pageId = parent === "pages" && detailId ? detailId : undefined;
  const { data: pageMeta } = usePage(pageId);

  const personId = parent === "people" && detailId ? detailId : undefined;
  const { data: personMeta } = useUser(personId);

  const sessionId = parent === "sessions" && detailId ? detailId : undefined;
  const { data: sessionMeta } = useSession(sessionId);

  const { data: appMeta } = useApp(idFor("apps") || undefined);
  const { data: agentMeta } = useAgent(idFor("agents"));
  const { data: workflowMeta } = useWorkflow(idFor("workflows"));
  // A run has no name of its own; label it by its workflow, not its id.
  const { data: workflowRunMeta } = useWorkflowRun(idFor("workflow-runs"));
  const { data: runWorkflowMeta } = useWorkflow(workflowRunMeta?.workflowId ?? "");
  const { data: scheduleMeta } = useScheduledTask(idFor("schedules"));
  const { data: scriptRunMeta } = useScriptRun(idFor("script-runs"));
  const { data: scriptMeta } = useScript(idFor("scripts"));
  const { data: skillMeta } = useSkill(idFor("skills"));
  const { data: mcpServerMeta } = useMcpServer(idFor("mcp-servers"));
  const { data: repoMeta } = useRepo(idFor("repos"));
  const { data: approvalMeta } = useApprovalRequest(idFor("approval-requests"));
  const { data: connectionMeta } = useScriptConnection(idFor("connections") || undefined);

  // `/usage/metrics/:id` — the one detail id at segment index 2. Resolved
  // here (like the index-1 entities above) because `PageHeader` drops string
  // titles: without this the dashboard's name would appear nowhere.
  const metricId =
    parent === "usage" && segments[1] === "metrics" && segments[2] ? segments[2] : undefined;
  const { data: metricMeta } = useMetricDefinition(metricId);

  // A task's ancestors go between "Tasks" and its id (`useTaskPath`, the
  // fetch the task page shares for its Session link). The desktop trail
  // folds the middle into "…" past a few crumbs or when it overflows; the
  // phone menu folds it into a row that expands in place.
  const taskId = parent === "tasks" ? detailId : undefined;
  const { data: taskPath } = useTaskPath(taskId);
  const ancestors = taskPath?.ancestors ?? [];
  const [desktopNav, setDesktopNav] = useState<HTMLElement | null>(null);
  const ancestorFit = useAncestorFit(desktopNav, taskId ?? "", ancestors.length);
  const [phoneAncestorsOpen, setPhoneAncestorsOpen] = useState(false);

  if (segments.length === 0) {
    return (
      <span className="min-w-0 truncate text-sm font-medium text-foreground">
        {user?.name ? `Hi, ${user.name}` : "Welcome to Agent Swarm"}
      </span>
    );
  }

  // Resolve the contextual name for the detail-id segment, if any. Falls back
  // to `undefined` (→ truncated-id display) while the entity is still loading.
  const contextualName: string | undefined = detailId
    ? parent === "apps"
      ? appMeta?.app.name
      : parent === "pages"
        ? pageMeta?.title
        : parent === "people"
          ? personMeta?.name
          : parent === "sessions"
            ? sessionMeta && sessionDisplayTitle(sessionMeta.root)
            : parent === "agents"
              ? agentMeta?.name
              : parent === "workflows"
                ? workflowMeta?.name
                : parent === "workflow-runs"
                  ? runWorkflowMeta && `Run of ${runWorkflowMeta.name}`
                  : parent === "schedules"
                    ? scheduleMeta?.name
                    : parent === "scripts"
                      ? scriptMeta?.name
                      : parent === "script-runs"
                        ? scriptRunMeta?.run.scriptName
                        : parent === "skills"
                          ? skillMeta?.name
                          : parent === "mcp-servers"
                            ? mcpServerMeta?.name
                            : parent === "repos"
                              ? repoMeta?.name
                              : parent === "approval-requests"
                                ? approvalMeta?.title
                                : parent === "connections"
                                  ? connectionMeta?.slug
                                  : undefined
    : undefined;

  // `/apps/:id/p/<page>` — one app page. The literal `p` segment is not a
  // route, so it is dropped from the trail and the page segment renders the
  // page's declared title (falling back to its name).
  const appPageName =
    parent === "apps" && segments[2] === "p" && segments[3] ? segments[3] : undefined;
  const appPageTitle = appPageName
    ? (appMeta?.app.definition.pages?.[appPageName]?.title ?? appPageName)
    : undefined;

  // A task's title is the page's own heading (often long, and editable
  // there), so its crumb is the short id instead.
  const taskCrumb = parent === "tasks" && detailId ? `#${shortId(detailId)}` : undefined;

  const crumbs = segments
    .map((segment, index) => {
      const defaultPath = `/${segments.slice(0, index + 1).join("/")}`;
      const path = routeRedirects[segment] ?? defaultPath;
      let label = formatSegment(segment, segments[index - 1]);
      // Pretty-print the detail-id leaf with the resolved entity name. Only the
      // id segment at index 1 is replaced — other path segments keep their
      // routeLabels behavior.
      if (index === 1 && segment === detailId && contextualName) {
        label = contextualName.trim();
      }
      const mono = index === 1 && segment === detailId && !!taskCrumb;
      if (mono) label = taskCrumb;
      if (index === 3 && appPageTitle) {
        label = appPageTitle.trim();
      }
      if (index === 2 && metricId && segment === metricId && metricMeta?.title) {
        label = metricMeta.title.trim();
      }
      const isLast = index === segments.length - 1;
      // The task crumb's lineage row: its hover card, and where its
      // ancestors go.
      const task = mono ? taskPath?.task : undefined;

      return { path, label, isLast, mono, task };
    })
    .filter((_, index) => !(appPageName && index === 2));

  const leaf = crumbs[crumbs.length - 1];

  // Phone menu rows, one indent step per level. The folded middle is one
  // row ("3 more") until it is opened; its tasks then share that level.
  type PhoneRow =
    | { kind: "crumb"; crumb: (typeof crumbs)[number] }
    | { kind: "ancestor"; task: AgentTask }
    | { kind: "more"; count: number };
  const phoneRows: { key: string; level: number; row: PhoneRow }[] = [];
  const nextLevel = () => (phoneRows.at(-1)?.level ?? 0) + 1;
  const addAncestor = (task: AgentTask, level = nextLevel()) =>
    phoneRows.push({ key: task.id, level, row: { kind: "ancestor", task } });
  for (const crumb of crumbs) {
    if (crumb.task && ancestors.length > 0) {
      const fold = collapseAncestors(ancestors, 2);
      for (const task of fold.head) addAncestor(task);
      if (fold.hidden.length > 0) {
        const level = nextLevel();
        if (phoneAncestorsOpen) {
          for (const task of fold.hidden) addAncestor(task, level);
        } else {
          phoneRows.push({ key: "more", level, row: { kind: "more", count: fold.hidden.length } });
        }
      }
      for (const task of fold.tail) addAncestor(task);
    }
    phoneRows.push({ key: crumb.path, level: nextLevel(), row: { kind: "crumb", crumb } });
  }

  // Desktop: the ancestors that fit, the rest behind "…". Null when not even
  // "…" fits: the trail is then the one it was before ancestors.
  const desktopFold = ancestorFit < 0 ? null : collapseAncestors(ancestors, ancestorFit);
  const ancestorCrumb = (task: AgentTask) => (
    <span key={task.id} className="flex shrink-0 items-center gap-1">
      <ChevronRight className="size-3 shrink-0" />
      <TaskCrumbPeek task={task}>
        <Link
          to={`/tasks/${task.id}`}
          aria-label={taskCrumbLabel(task)}
          className={cn(CRUMB_LINK, "font-mono")}
        >
          #{shortId(task.id)}
        </Link>
      </TaskCrumbPeek>
    </span>
  );

  return (
    <>
      {/* Mobile: the trail collapses into a dropdown. The trigger shows only
          the deepest level (truncated); the menu stacks every level
          top-to-bottom so the hierarchy is still readable on a narrow screen. */}
      <nav className="flex min-w-0 items-center md:hidden" aria-label="Breadcrumb">
        <DropdownMenu onOpenChange={(open) => !open && setPhoneAncestorsOpen(false)}>
          <DropdownMenuTrigger className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm text-foreground font-medium transition-colors hover:bg-accent">
            <span className={cn("truncate", leaf.mono && "font-mono")}>{leaf.label}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-w-[min(20rem,calc(100vw-2rem))]">
            <DropdownMenuItem asChild>
              <Link to="/" className="flex items-center gap-2">
                <Home className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">Home</span>
              </Link>
            </DropdownMenuItem>
            {phoneRows.map(({ key, level, row }) => {
              // Indent one step per level so the depth reads at a glance.
              const indent = { paddingLeft: `${0.5 + level * 0.75}rem` };
              if (row.kind === "more") {
                return (
                  <DropdownMenuItem
                    key={key}
                    style={indent}
                    // Opens the folded tasks in place and keeps the menu open.
                    onSelect={(event) => {
                      event.preventDefault();
                      setPhoneAncestorsOpen(true);
                    }}
                    className="text-muted-foreground"
                  >
                    <Ellipsis className="size-3.5" />
                    {row.count} more
                  </DropdownMenuItem>
                );
              }
              if (row.kind === "ancestor") {
                return (
                  <AncestorMenuItem
                    key={key}
                    task={row.task}
                    style={indent}
                    leading={
                      <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                    }
                  />
                );
              }
              const { crumb } = row;
              const content = (
                <>
                  <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className={cn("truncate", crumb.mono && "font-mono")}>{crumb.label}</span>
                </>
              );
              return (
                <DropdownMenuItem
                  key={key}
                  asChild={!crumb.isLast}
                  style={indent}
                  // The leaf is the current page: shown for context, not
                  // navigable (Radix `disabled` would grey it out, so it's
                  // just a non-link row that closes the menu).
                  className={cn(crumb.isLast && "font-medium text-foreground")}
                >
                  {crumb.isLast ? (
                    <span className="flex items-center gap-2">{content}</span>
                  ) : (
                    <Link to={crumb.path} className="flex items-center gap-2">
                      {content}
                    </Link>
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>

      {/* Desktop: the full inline trail. It takes the header's free width, so
          `useAncestorFit` can measure what fits. */}
      <nav
        ref={setDesktopNav}
        className="hidden md:flex flex-1 items-center gap-1 text-sm text-muted-foreground min-w-0"
        aria-label="Breadcrumb"
      >
        <Link to="/" className={cn(CRUMB_LINK, "shrink-0")}>
          Home
        </Link>
        {crumbs.map((crumb) => (
          <Fragment key={crumb.path}>
            {crumb.task && desktopFold ? (
              <>
                {desktopFold.head.map(ancestorCrumb)}
                {desktopFold.hidden.length > 0 ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <ChevronRight className="size-3 shrink-0" />
                    <HiddenAncestorsMenu tasks={desktopFold.hidden} />
                  </span>
                ) : null}
                {desktopFold.tail.map(ancestorCrumb)}
              </>
            ) : null}
            {/* Only the leaf gives up width: a long task title used to squeeze
                the "Tasks" crumb to nothing ("Home > > Fix the…"). */}
            <span className={cn("flex items-center gap-1", crumb.isLast ? "min-w-0" : "shrink-0")}>
              <ChevronRight className="size-3 shrink-0" />
              {crumb.isLast ? (
                <TaskCrumbPeek task={crumb.task}>
                  <span
                    data-crumb-leaf
                    // Focus opens the task's hover card for keyboard users.
                    tabIndex={crumb.task ? 0 : undefined}
                    className={cn(
                      "rounded-sm text-foreground font-medium truncate outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                      crumb.mono && "font-mono",
                    )}
                  >
                    {crumb.label}
                  </span>
                </TaskCrumbPeek>
              ) : (
                <TaskCrumbPeek task={crumb.task}>
                  <Link
                    to={crumb.path}
                    aria-label={crumb.task ? taskCrumbLabel(crumb.task) : undefined}
                    className={cn(CRUMB_LINK, "truncate", crumb.mono && "font-mono")}
                  >
                    {crumb.label}
                  </Link>
                </TaskCrumbPeek>
              )}
            </span>
          </Fragment>
        ))}
      </nav>
    </>
  );
}
