import {
  BarChart3,
  Blocks,
  BookOpen,
  Boxes,
  Brain,
  Bug,
  Cable,
  ClipboardCheck,
  Clock,
  Contact,
  Cpu,
  FileClock,
  FileText,
  FlaskConical,
  FolderGit2,
  FolderOpen,
  Globe,
  Key,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  LineChart,
  Link2,
  ListTodo,
  MessageSquare,
  MessagesSquare,
  Network,
  Palette,
  PiggyBank,
  Plug,
  Plus,
  SlidersHorizontal,
  Store,
  UserSearch,
  Users,
  Wallet,
  Workflow,
  Wrench,
} from "lucide-react";
import { type ReactNode, Suspense } from "react";
import { Navigate, type RouteObject } from "react-router-dom";
import { RootLayout } from "@/components/layout/root-layout";
import { LinkPreviewScope } from "@/components/link-preview/link-preview-state";
import { lazyRoute } from "@/components/shared/app-update-prompt";
import { HiveLoadingScreen } from "@/components/shared/hive-loading-screen";
import { AdminRoute, SettingsLayout } from "@/pages/settings/settings-layout";
import { UsageLayout } from "@/pages/usage/usage-layout";
// Relative, not `@/`: `routes.test.ts` loads this file under `bun test`.
import { nav, unlisted } from "../lib/command-palette/route-meta";
import { connectPagePath, type IntegrationCategory } from "../lib/integrations-catalog";
import { RouteRedirect } from "./route-redirect";
import { SessionsRoute as SessionsPage } from "./sessions-route";

const UnifiedHome = lazyRoute(() => import("@/pages/home/unified-home"));
const AgentsPage = lazyRoute(() => import("@/pages/agents/page"));
const AgentDetailPage = lazyRoute(() => import("@/pages/agents/[id]/page"));
const TasksPage = lazyRoute(() => import("@/pages/tasks/page"));
const TaskDetailPage = lazyRoute(() => import("@/pages/tasks/[id]/page"));
const TaskLineagePage = lazyRoute(() => import("@/pages/tasks/[id]/lineage/page"));
const ChatPage = lazyRoute(() => import("@/pages/chat/page"));
const SchedulesPage = lazyRoute(() => import("@/pages/schedules/page"));
const ScheduleDetailPage = lazyRoute(() => import("@/pages/schedules/[id]/page"));
const UsageContent = lazyRoute(() =>
  import("@/pages/usage/usage-content").then((m) => ({ default: m.UsageContent })),
);
const BudgetsPage = lazyRoute(() => import("@/pages/budgets/page"));
const SavingsPage = lazyRoute(() =>
  import("@/pages/usage/savings-page").then((m) => ({ default: m.SavingsPage })),
);
const ConnectionsPage = lazyRoute(() => import("@/pages/settings/connections-page"));
const AppearancePage = lazyRoute(() => import("@/pages/settings/appearance-page"));
const SecretsPage = lazyRoute(() => import("@/pages/settings/secrets-page"));
const ConfigurationPage = lazyRoute(() => import("@/pages/settings/configuration-page"));
const ExtensionsPage = lazyRoute(() => import("@/pages/settings/extensions-page"));
const ExtensionCatalogPage = lazyRoute(() => import("@/pages/settings/extension-catalog-page"));
const RuntimePoolsPage = lazyRoute(() => import("@/pages/settings/runtime-pools-page"));
const RuntimePoolDetailPage = lazyRoute(() => import("@/pages/settings/runtime-pool-detail-page"));
const RuntimeControllersPage = lazyRoute(() => import("@/pages/settings/runtime-controllers-page"));
const IntegrationDetailPage = lazyRoute(() => import("@/pages/integrations/[id]/page"));
const ReposPage = lazyRoute(() => import("@/pages/repos/page"));
const RepoDetailPage = lazyRoute(() => import("@/pages/repos/[id]/page"));
const WorkflowsPage = lazyRoute(() => import("@/pages/workflows/page"));
const WorkflowDetailPage = lazyRoute(() => import("@/pages/workflows/[id]/page"));
const WorkflowRunDetailPage = lazyRoute(() => import("@/pages/workflow-runs/[id]/page"));
const ScriptConnectionDetailPage = lazyRoute(() => import("@/pages/connections/[id]/page"));
const OAuthAppDetailPage = lazyRoute(() => import("@/pages/connections/oauth-apps/[id]/page"));
const ScriptsPage = lazyRoute(() => import("@/pages/scripts/page"));
const ScriptDetailPage = lazyRoute(() => import("@/pages/scripts/[id]/page"));
const ScriptRunDetailPage = lazyRoute(() => import("@/pages/script-runs/[id]/page"));
const TemplatesPage = lazyRoute(() => import("@/pages/templates/page"));
const TemplateDetailPage = lazyRoute(() => import("@/pages/templates/[id]/page"));
const TemplateVersionDetailPage = lazyRoute(
  () => import("@/pages/templates/[id]/history/[version]/page"),
);
const ApprovalRequestsPage = lazyRoute(() => import("@/pages/approval-requests/page"));
const ApprovalRequestDetailPage = lazyRoute(() => import("@/pages/approval-requests/[id]/page"));
const McpServerDetailPage = lazyRoute(() => import("@/pages/mcp-servers/[id]/page"));
const SkillsPage = lazyRoute(() => import("@/pages/skills/page"));
const SkillDetailPage = lazyRoute(() => import("@/pages/skills/[id]/page"));
const ChannelsPage = lazyRoute(() => import("@/pages/connect-pages/channels-page"));
const ToolsPage = lazyRoute(() => import("@/pages/connect-pages/tools-page"));
const AiProvidersPage = lazyRoute(() => import("@/pages/connect-pages/ai-page"));
const ConnectionPlaygroundPage = lazyRoute(
  () => import("@/pages/settings/connection-playground-page"),
);
const FetchCredentialsPage = lazyRoute(() => import("@/pages/settings/fetch-credentials-page"));
const PeoplePage = lazyRoute(() => import("@/pages/people/page"));
const PersonDetailPage = lazyRoute(() => import("@/pages/people/[id]/page"));
const DebugPage = lazyRoute(() => import("@/pages/debug/page"));
const MemoryPage = lazyRoute(() => import("@/pages/memory/page"));
const MetricsPage = lazyRoute(() => import("@/pages/metrics/page"));
const PageDetailPage = lazyRoute(() => import("@/pages/pages/[id]/page"));
const PagesListingPage = lazyRoute(() => import("@/pages/pages/page"));
const AppsListingPage = lazyRoute(() => import("@/pages/apps/page"));
const AppDetailPage = lazyRoute(() => import("@/pages/apps/[id]/page"));
const CombPage = lazyRoute(() => import("@/pages/comb/page"));
const NotFoundPage = lazyRoute(() => import("@/pages/not-found/page"));
/** An admin-only Settings route (`AdminRoute`). */
const admin = (element: ReactNode) => <AdminRoute>{element}</AdminRoute>;

const SetupPage = lazyRoute(() => import("@/pages/setup/page"));
const ConnectPage = lazyRoute(() => import("@/pages/connect/page"));
const FsContinuePage = lazyRoute(() => import("@/pages/fs-continue/page"));
const JoinPage = lazyRoute(() => import("@/pages/join/page"));

/**
 * Dev-only routes. `/dev/embed-test` mounts an `<AppSurface>` outside the
 * `/apps` tier — the standing proof that the app runtime is embeddable
 * anywhere in the dashboard.
 *
 * The `lazyRoute(() => import(…))` lives INSIDE the `import.meta.env.DEV` branch on
 * purpose: at module scope it would be an unconditional dynamic import, and
 * the dev page would be emitted as a (dead but shipped) chunk in production
 * builds. Behind the constant-folded flag the whole branch is dropped.
 */
function devRouteTable(): RouteObject[] {
  if (!import.meta.env.DEV) return [];
  const DevEmbedTestPage = lazyRoute(() => import("@/pages/dev/embed-test/page"));
  return [
    { path: "dev/embed-test", element: <DevEmbedTestPage />, handle: unlisted("dev-only page") },
  ];
}

const devRoutes: RouteObject[] = devRouteTable();

/**
 * Backward-compat redirect table: every old URL that moved maps to its new
 * location, so no old link 404s. `RouteRedirect` keeps the query and the
 * hash. Routes nested under a layout (`settings/*`) carry their own redirect
 * entries next to their siblings.
 */
const REDIRECTS: Record<string, string> = {
  dashboard: "/",
  budgets: "/usage/budgets",
  config: "/settings/connections",
  keys: "/integrations/ai",
  repos: "/settings/repos",
  debug: "/settings/debug",
  metrics: "/usage/metrics",
  // The standalone script-runs list folded into the Scripts page's Runs tab.
  "script-runs": "/scripts?tab=runs",
  // Connect owns `/integrations`; its first page is Tools.
  integrations: "/integrations/tools",
  "mcp-servers": "/integrations/tools?tab=mcp",
};

const REDIRECT = unlisted("redirect", { searchOptOut: "redirect" });

/** Old `/connections?tab=` values: two moved to Settings › Advanced. */
function connectionsRedirect(_params: unknown, location: { search: string }): string {
  const tab = new URLSearchParams(location.search).get("tab");
  if (tab === "playground") return "/settings/connection-playground";
  if (tab === "bindings") return "/settings/fetch-credentials";
  return `/integrations/tools?tab=${tab === "oauth-apps" ? "oauth-apps" : "connections"}`;
}

/** Old `/settings/integrations?category=`: channels and AI providers have their own pages. */
function integrationsRedirect(_params: unknown, location: { search: string }): string {
  const category = new URLSearchParams(location.search).get("category") ?? "";
  return connectPagePath(category as IntegrationCategory);
}

const redirectRoutes: RouteObject[] = [
  ...Object.entries(REDIRECTS).map(([from, to]) => ({
    path: from,
    element: <RouteRedirect to={to} />,
    handle: REDIRECT,
  })),
  {
    path: "connections",
    element: <RouteRedirect to={connectionsRedirect} drop={["tab"]} />,
    handle: REDIRECT,
  },
  {
    path: "connections/:id",
    element: <RouteRedirect to={({ id }) => `/integrations/tools/connections/${id}`} />,
  },
  {
    path: "connections/oauth-apps/:id",
    element: <RouteRedirect to={({ id }) => `/integrations/tools/oauth-apps/${id}`} />,
  },
  {
    path: "mcp-servers/:id",
    element: <RouteRedirect to={({ id }) => `/integrations/tools/mcp-servers/${id}`} />,
  },
];

/** Redirects for the Settings pages that moved to Connect. */
const settingsRedirectRoutes: RouteObject[] = [
  { path: "api-keys", element: <RouteRedirect to="/integrations/ai" />, handle: REDIRECT },
  {
    path: "integrations",
    element: <RouteRedirect to={integrationsRedirect} drop={["category"]} />,
    handle: REDIRECT,
  },
  {
    path: "integrations/:id",
    element: <RouteRedirect to={({ id }) => `/integrations/${id}`} />,
  },
];

/**
 * Every route the dashboard serves. A static route's `handle` lists it in
 * Cmd+K (`nav`) or says why not (`unlisted`); an entity list names its search
 * providers or says why it has none. `routes.test.ts` fails on a route that
 * does neither, so a new page cannot ship missing from the palette.
 */
export const appRoutes: RouteObject[] = [
  // First-run onboarding: full page, outside the app shell (no sidebar/header).
  {
    path: "/setup",
    element: (
      <Suspense fallback={<HiveLoadingScreen fullPage />}>
        <SetupPage />
      </Suspense>
    ),
    handle: unlisted("first-run flow outside the app shell"),
  },
  // Inbound handoff from the agent-swarm.dev connector. Also outside the app
  // shell: it opens as a fresh tab and must work with no connection yet.
  {
    path: "/connect",
    element: (
      <Suspense fallback={<HiveLoadingScreen fullPage />}>
        <ConnectPage />
      </Suspense>
    ),
    handle: unlisted("connector handoff outside the app shell"),
  },
  // A teammate's invite link. Outside the app shell: it saves the connection
  // the shell then uses, so it must work with no connection yet.
  {
    path: "/join",
    element: (
      <Suspense fallback={<HiveLoadingScreen fullPage />}>
        <JoinPage />
      </Suspense>
    ),
    handle: unlisted("invite link outside the app shell"),
  },
  {
    path: "/",
    element: <RootLayout />,
    children: [
      // `/` is served by `UnifiedHome` (pages/home/unified-home.tsx) — the sole
      // home surface. The former `/old-home` and `/old-dashboard` pages are gone.
      {
        index: true,
        element: <UnifiedHome />,
        handle: nav({ title: "Home", icon: LayoutDashboard, keywords: ["dashboard"] }),
      },
      {
        path: "agents",
        element: <AgentsPage />,
        handle: nav({ title: "Agents", icon: Users }, { search: ["agents"] }),
      },
      { path: "agents/:id", element: <AgentDetailPage /> },
      {
        path: "tasks",
        element: <TasksPage />,
        handle: nav({ title: "Tasks", icon: ListTodo }, { search: ["tasks"] }),
      },
      {
        path: "tasks/:id",
        element: (
          <LinkPreviewScope>
            <TaskDetailPage />
          </LinkPreviewScope>
        ),
      },
      { path: "tasks/:id/lineage", element: <TaskLineagePage /> },
      // One page for both paths (as chat does), so the sessions v2 shell stays
      // mounted when the focused session changes. It also picks the legacy pages.
      {
        path: "sessions",
        element: (
          <LinkPreviewScope>
            <SessionsPage />
          </LinkPreviewScope>
        ),
        handle: nav(
          { title: "Sessions", icon: MessageSquare, minVersion: "1.76.0" },
          { searchOptOut: "the sessions page adds its own palette group" },
        ),
      },
      {
        path: "sessions/:rootTaskId",
        element: (
          <LinkPreviewScope>
            <SessionsPage />
          </LinkPreviewScope>
        ),
      },
      {
        path: "chat",
        element: <ChatPage />,
        handle: nav(
          { title: "Chat", icon: MessagesSquare, keywords: ["channels"] },
          { searchOptOut: "channels are few and listed in the chat sidebar" },
        ),
      },
      { path: "chat/:channelId", element: <ChatPage /> },
      {
        path: "schedules",
        element: <SchedulesPage />,
        handle: nav(
          { title: "Schedules", icon: Clock, keywords: ["cron"], adminOnly: true },
          { search: ["schedules"] },
        ),
      },
      { path: "schedules/:id", element: <ScheduleDetailPage /> },
      {
        path: "workflows",
        element: <WorkflowsPage />,
        handle: nav(
          { title: "Workflows", icon: Workflow, adminOnly: true },
          { search: ["workflows"] },
        ),
      },
      { path: "workflows/:id", element: <WorkflowDetailPage /> },
      { path: "workflow-runs/:id", element: <WorkflowRunDetailPage /> },
      // Connect: three pages, admin only. `/integrations` itself redirects to Tools.
      {
        path: "integrations/channels",
        element: admin(<ChannelsPage />),
        handle: nav({
          title: "Channels",
          icon: MessagesSquare,
          parent: "Connect",
          keywords: ["slack", "telegram", "discord", "chat sdk"],
          adminOnly: true,
        }),
      },
      {
        path: "integrations/tools",
        element: admin(<ToolsPage />),
        handle: nav({
          title: "Tools",
          icon: Wrench,
          parent: "Connect",
          keywords: ["integrations", "github", "linear", "jira", "oauth"],
          adminOnly: true,
        }),
      },
      {
        path: "integrations/ai",
        element: admin(<AiProvidersPage />),
        handle: nav({
          title: "AI providers",
          icon: Cpu,
          parent: "Connect",
          keywords: ["llm", "provider keys", "api keys", "anthropic", "openai"],
          adminOnly: true,
        }),
      },
      // The Tools tabs as static paths, so Cmd+K and the breadcrumbs can name them.
      {
        path: "integrations/tools/connections",
        element: <RouteRedirect to="/integrations/tools?tab=connections" />,
        handle: nav(
          {
            title: "Script connections",
            icon: Link2,
            parent: "Connect",
            keywords: ["connections", "openapi", "graphql"],
            adminOnly: true,
          },
          { searchOptOut: "the script-connections API has no search yet" },
        ),
      },
      {
        path: "integrations/tools/oauth-apps",
        element: <RouteRedirect to="/integrations/tools?tab=oauth-apps" />,
        handle: nav(
          { title: "OAuth apps", icon: KeyRound, parent: "Connect", adminOnly: true },
          { searchOptOut: "OAuth apps are few and listed on the page" },
        ),
      },
      {
        path: "integrations/tools/mcp-servers",
        element: <RouteRedirect to="/integrations/tools?tab=mcp" />,
        handle: nav(
          { title: "MCP servers", icon: Cable, parent: "Connect", adminOnly: true },
          { search: ["mcp-servers"] },
        ),
      },
      // Static segments (`channels`, `tools`, `ai`) rank above `:id`.
      { path: "integrations/:id", element: admin(<IntegrationDetailPage />) },
      { path: "integrations/tools/connections/:id", element: <ScriptConnectionDetailPage /> },
      { path: "integrations/tools/oauth-apps/:id", element: <OAuthAppDetailPage /> },
      { path: "integrations/tools/mcp-servers/:id", element: <McpServerDetailPage /> },
      {
        path: "scripts",
        element: <ScriptsPage />,
        handle: nav(
          { title: "Scripts", icon: FileClock, keywords: ["runs"], adminOnly: true },
          { searchOptOut: "the scripts API has no search yet" },
        ),
      },
      { path: "scripts/:id", element: <ScriptDetailPage /> },
      { path: "script-runs/:id", element: <ScriptRunDetailPage /> },
      {
        path: "approval-requests",
        element: <ApprovalRequestsPage />,
        handle: nav(
          { title: "Approvals", icon: ClipboardCheck, keywords: ["approval requests", "review"] },
          { searchOptOut: "a short queue, filtered by status on the page" },
        ),
      },
      { path: "approval-requests/:id", element: <ApprovalRequestDetailPage /> },
      {
        path: "usage",
        element: <UsageLayout />,
        children: [
          {
            index: true,
            element: <UsageContent />,
            handle: nav({
              title: "Usage",
              icon: BarChart3,
              keywords: ["cost", "spend"],
              adminOnly: true,
            }),
          },
          {
            path: "budgets",
            element: <BudgetsPage />,
            handle: nav({ title: "Budgets", icon: Wallet, parent: "Usage", adminOnly: true }),
          },
          {
            path: "metrics",
            element: <MetricsPage />,
            handle: nav(
              { title: "Metrics", icon: LineChart, parent: "Usage", adminOnly: true },
              { searchOptOut: "metric definitions are listed on the page" },
            ),
          },
          { path: "metrics/:id", element: <MetricsPage /> },
          {
            path: "savings",
            element: <SavingsPage />,
            handle: nav({
              title: "Savings",
              icon: PiggyBank,
              parent: "Usage",
              keywords: ["automation", "saved"],
              adminOnly: true,
            }),
          },
        ],
      },
      {
        path: "settings",
        element: <SettingsLayout />,
        children: [
          {
            index: true,
            element: <Navigate to="/settings/connections" replace />,
            handle: REDIRECT,
          },
          {
            path: "config",
            element: <Navigate to="/settings/connections" replace />,
            handle: REDIRECT,
          },
          {
            path: "connections",
            element: <ConnectionsPage />,
            handle: nav({
              title: "Servers",
              icon: Network,
              parent: "Settings",
              keywords: ["swarm connections", "api url"],
            }),
          },
          {
            path: "appearance",
            element: <AppearancePage />,
            handle: nav({
              title: "Appearance",
              icon: Palette,
              parent: "Settings",
              keywords: ["theme"],
            }),
          },
          {
            path: "secrets",
            element: admin(<SecretsPage />),
            handle: nav({ title: "Secrets", icon: KeyRound, parent: "Settings", adminOnly: true }),
          },
          ...settingsRedirectRoutes,
          {
            path: "connection-playground",
            element: admin(<ConnectionPlaygroundPage />),
            handle: nav({
              title: "Playground",
              icon: FlaskConical,
              parent: "Settings",
              keywords: ["connection playground", "script connections", "try"],
              adminOnly: true,
            }),
          },
          {
            path: "fetch-credentials",
            element: admin(<FetchCredentialsPage />),
            handle: nav({
              title: "Fetch credentials",
              icon: Key,
              parent: "Settings",
              keywords: ["raw fetch credentials", "credential bindings", "fetch"],
              adminOnly: true,
            }),
          },
          {
            path: "configuration",
            element: admin(<ConfigurationPage />),
            handle: nav({
              title: "Configuration",
              icon: SlidersHorizontal,
              parent: "Settings",
              keywords: ["env", "flags"],
              adminOnly: true,
            }),
          },
          {
            path: "extensions/new",
            element: admin(<ExtensionCatalogPage />),
            handle: nav({
              title: "Extension catalog",
              icon: Store,
              parent: "Settings",
              keywords: ["install extension"],
              adminOnly: true,
            }),
          },
          // One route for the grid and its detail sheet, so opening and closing
          // the sheet keeps the page mounted.
          {
            path: "extensions/:id?",
            element: admin(<ExtensionsPage />),
            handle: nav(
              { title: "Extensions", icon: Blocks, parent: "Settings", adminOnly: true },
              { searchOptOut: "installed extensions are few and shown as a grid" },
            ),
          },
          {
            path: "runtime-pools",
            element: admin(<RuntimePoolsPage />),
            handle: nav(
              {
                title: "Runtime pools",
                icon: Boxes,
                parent: "Settings",
                keywords: ["docker", "e2b"],
                adminOnly: true,
                requires: "runtime-pools",
              },
              { searchOptOut: "pools are few and listed on the page" },
            ),
          },
          {
            path: "runtime-pools/new",
            element: admin(<RuntimePoolDetailPage />),
            handle: nav({
              title: "New runtime pool",
              icon: Plus,
              parent: "Settings",
              adminOnly: true,
              requires: "runtime-pools",
            }),
          },
          {
            path: "runtime-pools/controllers",
            element: admin(<RuntimeControllersPage />),
            handle: nav({
              title: "Runtime controllers",
              icon: Boxes,
              parent: "Settings",
              adminOnly: true,
              requires: "runtime-pools",
            }),
          },
          { path: "runtime-pools/:id", element: admin(<RuntimePoolDetailPage />) },
          {
            path: "repos",
            element: admin(<ReposPage />),
            handle: nav({
              title: "Repos",
              icon: FolderGit2,
              parent: "Settings",
              keywords: ["repositories", "github"],
              adminOnly: true,
            }),
          },
          {
            path: "debug",
            element: admin(<DebugPage />),
            handle: nav({
              title: "Debug",
              icon: Bug,
              parent: "Settings",
              keywords: ["sql"],
              adminOnly: true,
            }),
          },
        ],
      },
      {
        path: "skills",
        element: <SkillsPage />,
        handle: nav({ title: "Skills", icon: BookOpen, adminOnly: true }, { search: ["skills"] }),
      },
      { path: "skills/:id", element: <SkillDetailPage /> },
      // Settings-rail pages that keep their own URLs: the rail stays beside them.
      {
        element: <SettingsLayout />,
        children: [
          {
            path: "templates",
            element: <TemplatesPage />,
            handle: nav(
              {
                title: "Templates",
                icon: FileText,
                keywords: ["prompt templates"],
                adminOnly: true,
              },
              { searchOptOut: "the prompt-templates API has no search yet" },
            ),
          },
          { path: "templates/:id", element: <TemplateDetailPage /> },
          { path: "templates/:id/history/:version", element: <TemplateVersionDetailPage /> },
          { path: "repos/:id", element: <RepoDetailPage /> },
          {
            path: "people",
            element: <PeoplePage />,
            handle: nav(
              {
                title: "People",
                icon: Contact,
                keywords: ["users"],
                minVersion: "1.80.0",
                adminOnly: true,
              },
              { searchOptOut: "the users API has no search yet" },
            ),
          },
          {
            path: "people/unmapped",
            element: <PeoplePage />,
            handle: nav({
              title: "Unmapped identities",
              icon: UserSearch,
              parent: "People",
              minVersion: "1.80.0",
              adminOnly: true,
            }),
          },
          { path: "people/:id", element: <PersonDetailPage /> },
        ],
      },
      {
        path: "memory",
        element: <MemoryPage />,
        handle: nav({ title: "Memory", icon: Brain, keywords: ["memories"], adminOnly: true }),
      },
      {
        path: "pages",
        element: <PagesListingPage />,
        handle: nav({ title: "Pages", icon: Globe, minVersion: "1.79.0" }, { search: ["pages"] }),
      },
      { path: "pages/:id", element: <PageDetailPage /> },
      {
        path: "apps",
        element: <AppsListingPage />,
        handle: nav({ title: "Apps", icon: LayoutGrid }, { search: ["apps"] }),
      },
      { path: "apps/:id", element: <AppDetailPage /> },
      // A named page of a multi-page app. Same component as `apps/:id` (which
      // renders the app's `defaultPage`) — both URLs stay valid, no redirect.
      { path: "apps/:id/p/:page", element: <AppDetailPage /> },
      // Comb. `/file` redirects to the swarm drive once `/status` names it.
      {
        path: "file",
        element: <CombPage />,
        handle: nav(
          { title: "Files", icon: FolderOpen, keywords: ["comb", "drive"], requires: "comb" },
          { search: ["files-name", "files-content"] },
        ),
      },
      { path: "file/~/:orgId/:driveId/*", element: <CombPage /> },
      {
        path: "fs/continue",
        element: <FsContinuePage />,
        handle: unlisted("agent-fs continue handoff"),
      },
      ...devRoutes,
      ...redirectRoutes,
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
