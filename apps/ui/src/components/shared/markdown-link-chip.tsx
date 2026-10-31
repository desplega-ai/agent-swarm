import { skipToken, useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Cable,
  ClipboardCheck,
  Clock,
  Contact,
  FileClock,
  FileText,
  FolderGit,
  Globe,
  LayoutGrid,
  Link2,
  ListTodo,
  type LucideIcon,
  MessageSquare,
  Users,
  Workflow,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { defaultRehypePlugins, type ExtraProps, type StreamdownProps } from "streamdown";
import { api } from "@/api/client";
import type { AgentTask } from "@/api/types";
import { useOptionalStatusContext } from "@/app/status-context";
import { FileKindIcon } from "@/components/comb/file-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import { useCombLinks } from "@/hooks/use-comb-links";
import { shortId } from "@/lib/short-id";
import {
  DASHBOARD_ROUTES,
  type DashboardRoute,
  parseSwarmLink,
  type SwarmLink,
  type SwarmLinkOrigins,
} from "@/lib/swarm-links";
import { taskListTitle } from "@/lib/task-title";
import { InAppOrExternalLink } from "./in-app-or-external-link";

/** The sidebar's icon for each route. */
const ROUTE_ICONS: Record<DashboardRoute, LucideIcon> = {
  pages: Globe,
  tasks: ListTodo,
  sessions: MessageSquare,
  apps: LayoutGrid,
  workflows: Workflow,
  "workflow-runs": Workflow,
  agents: Users,
  schedules: Clock,
  scripts: FileClock,
  "script-runs": FileClock,
  "approval-requests": ClipboardCheck,
  skills: BookOpen,
  "mcp-servers": Cable,
  templates: FileText,
  repos: FolderGit,
  people: Contact,
};

interface Named {
  /** The query key's first part, shared with the entity's own hook. */
  key: string;
  /** Null: read the cache only. */
  fetch: ((id: string) => Promise<unknown>) | null;
  name: (data: unknown) => string | undefined;
}

function named<T>(
  key: string,
  fetch: ((id: string) => Promise<T>) | null,
  name: (data: T) => string | undefined,
): Named {
  return { key, fetch, name: (data) => name(data as T) };
}

/** Where a chip finds a name. A task can carry its whole log, so tasks and sessions (a root task) read only the cache. */
const NAMED: Partial<Record<DashboardRoute, Named>> = {
  pages: named(
    "page",
    (id) => api.getPage(id),
    (page) => page.title,
  ),
  apps: named(
    "app",
    (id) => api.getApp(id),
    (data) => data.app.name,
  ),
  workflows: named(
    "workflow",
    (id) => api.fetchWorkflow(id),
    (workflow) => workflow.name,
  ),
  agents: named(
    "agent",
    (id) => api.fetchAgent(id, false),
    (agent) => agent.name,
  ),
  tasks: named<AgentTask>("task", null, taskListTitle),
  sessions: named<AgentTask>("task", null, taskListTitle),
};

/** The resolved name of a dashboard link. Undefined until known, or when the swarm has no such thing. */
function useLinkName(link: SwarmLink | null): string | undefined {
  const entry = link?.type === "dashboard" ? NAMED[link.route] : undefined;
  const id = link?.type === "dashboard" ? link.id : "";
  const fetchEntity = entry?.fetch;
  const { data } = useQuery({
    queryKey: [entry?.key ?? "swarm-link", id],
    queryFn: fetchEntity ? () => fetchEntity(id) : skipToken,
    select: (value: unknown) => (entry && value ? entry.name(value) : undefined),
    staleTime: 5 * 60_000,
    refetchInterval: false,
    retry: false,
  });
  return data?.trim() || undefined;
}

/** The origins this dashboard knows: its own, the swarm's configured dashboard, and agent-fs. */
export function useSwarmLinkOrigins(): SwarmLinkOrigins {
  const configuredDashboard = useOptionalStatusContext()?.data?.identity.dashboard_url ?? null;
  const agentFs = useOptionalAgentFs();
  const agentFsLive = agentFs?.liveUrl ?? null;
  const agentFsApi = agentFs?.endpoint ?? null;
  return useMemo(
    () => ({ dashboard: window.location.origin, configuredDashboard, agentFsLive, agentFsApi }),
    [configuredDashboard, agentFsLive, agentFsApi],
  );
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Renames each `a` that names a swarm thing to `swarm-link`, which `SwarmLinkChip` renders. */
function rehypeSwarmLinks(origins: SwarmLinkOrigins) {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      for (const child of node.children ?? []) {
        const href = child.tagName === "a" ? child.properties?.href : undefined;
        if (typeof href === "string" && parseSwarmLink(href, origins)) child.tagName = "swarm-link";
        else walk(child);
      }
    };
    walk(tree);
  };
}

type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>;

/**
 * Streamdown's own rehype plugins, then the swarm-link one. Pass it with
 * `"swarm-link": SwarmLinkChip` in `components`. Other links keep Streamdown's
 * handling, the external-link check included.
 */
export function useSwarmLinkPlugins(): RehypePlugins {
  const origins = useSwarmLinkOrigins();
  return useMemo(
    () => [
      ...Object.values(defaultRehypePlugins),
      [rehypeSwarmLinks, origins] as unknown as RehypePlugins[number],
    ],
    [origins],
  );
}

function textOf(node: HastNode | undefined): string {
  if (!node) return "";
  return node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join("");
}

const withoutScheme = (value: string) => value.replace(/^https?:\/\//i, "").replace(/\/$/, "");

/**
 * A link to this swarm as a chip: the kind's icon and a short label. A
 * dashboard link reads as its name when the dashboard has it ("Page
 * cfd9bc4b" otherwise) and opens in the same tab. A drive file reads as its
 * name, with the path in the tooltip, and opens in Comb while Comb is
 * connected, else in a new tab. A share link reads "Shared file". Link text
 * that is not the URL stays as written.
 */
export function SwarmLinkChip({ href, children, node }: Record<string, unknown> & ExtraProps) {
  const origins = useSwarmLinkOrigins();
  const link = typeof href === "string" ? parseSwarmLink(href, origins) : null;
  const name = useLinkName(link);
  const combTo = useCombLinks()(link?.type === "file" ? link.href : null);
  if (!link) return <>{children as ReactNode}</>;

  const written = textOf(node as HastNode | undefined).trim();
  const isUrl = !written || written === href || withoutScheme(written) === withoutScheme(link.href);
  let icon: ReactNode;
  let label: string;
  let tip: string;
  let to: string | null = null;
  const iconClass = "size-3.5 shrink-0 self-center text-muted-foreground";
  if (link.type === "dashboard") {
    const Icon = ROUTE_ICONS[link.route];
    icon = <Icon aria-hidden className={iconClass} />;
    label = name ?? `${DASHBOARD_ROUTES[link.route]} ${shortId(link.id)}`;
    tip = `${DASHBOARD_ROUTES[link.route]} ${link.id}`;
    to = link.path;
  } else if (link.type === "file") {
    icon = <FileKindIcon name={link.name} isFolder={link.folder} className={iconClass} />;
    label = link.name;
    tip = link.path;
    to = combTo;
  } else {
    icon = <Link2 aria-hidden className={iconClass} />;
    label = link.name ?? "Shared file";
    tip = "Shared agent-fs file";
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <InAppOrExternalLink
          to={to}
          href={link.href}
          data-slot="swarm-link"
          // `!`: the unlayered `.prose-chat a` rules would underline it on hover.
          className="hover-linger inline-flex max-w-full items-baseline gap-1 rounded-md bg-muted px-1.5 font-medium text-primary no-underline! transition-colors outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {icon}
          <span className="min-w-0 overflow-x-clip text-ellipsis whitespace-nowrap">
            {isUrl ? label : (children as ReactNode)}
          </span>
        </InAppOrExternalLink>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  );
}
