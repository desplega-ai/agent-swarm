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
  FileClock,
  FileText,
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
  Plug,
  Plus,
  SlidersHorizontal,
  Store,
  UserSearch,
  Users,
  Wallet,
  Workflow,
} from "lucide-react";
import { type ReactNode, Suspense } from "react";
import { Navigate, type RouteObject } from "react-router-dom";
import { RootLayout } from "@/components/layout/root-layout";
import { lazyRoute } from "@/components/shared/app-update-prompt";
import { HiveLoadingScreen } from "@/components/shared/hive-loading-screen";
import { AdminRoute, SettingsLayout } from "@/pages/settings/settings-layout";
import { UsageLayout } from "@/pages/usage/usage-layout";
// Relative, not `@/`: `routes.test.ts` loads this file under `bun test`.
import { nav, unlisted } from "../lib/command-palette/route-meta";
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
const ConnectionsPage = lazyRoute(() => import("@/pages/settings/connections-page"));
const AppearancePage = lazyRoute(() => import("@/pages/settings/appearance-page"));
const SecretsPage = lazyRoute(() => import("@/pages/settings/secrets-page"));
const ConfigurationPage = lazyRoute(() => import("@/pages/settings/configuration-page"));
const ExtensionsPage = lazyRoute(() => import("@/pages/settings/extensions-page"));
const ExtensionCatalogPage = lazyRoute(() => import("@/pages/settings/extension-catalog-page"));
const RuntimePoolsPage = lazyRoute(() => import("@/pages/settings/runtime-pools-page"));
const RuntimePoolDetailPage = lazyRoute(() => import("@/pages/settings/runtime-pool-detail-page"));
const RuntimeControllersPage = lazyRoute(() => import("@/pages/settings/runtime-controllers-page"));
const IntegrationsPage = lazyRoute(() => import("@/pages/integrations/page"));
const IntegrationDetailPage = lazyRoute(() => import("@/pages/integrations/[id]/page"));
const ReposPage = lazyRoute(() => import("@/pages/repos/page"));
const RepoDetailPage = lazyRoute(() => import("@/pages/repos/[id]/page"));
const WorkflowsPage = lazyRoute(() => import("@/pages/workflows/page"));
const WorkflowDetailPage = lazyRoute(() => import("@/pages/workflows/[id]/page"));
const WorkflowRunDetailPage = lazyRoute(() => import("@/pages/workflow-runs/[id]/page"));
const ScriptConnectionsPage = lazyRoute(() => import("@/pages/connections/page"));
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
const McpServersPage = lazyRoute(() => import("@/pages/mcp-servers/page"));
const McpServerDetailPage = lazyRoute(() => import("@/pages/mcp-servers/[id]/page"));
const SkillsPage = lazyRoute(() => import("@/pages/skills/page"));
const SkillDetailPage = lazyRoute(() => import("@/pages/skills/[id]/page"));
const ApiKeysPage = lazyRoute(() => import("@/pages/api-keys/page"));
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
 * Backward-compat redirect table — every old top-level URL that moved during
 * the sidebar-trim IA rework maps to its new location, so no old link 404s.
 * Simple (non-param) redirects live here; the param-aware `/integrations/:id`
 * case is handled separately via `RouteRedirect` below.
 */
const REDIRECTS: Record<string, string> = {
  dashboard: "/",
  budgets: "/usage/budgets",
  config: "/settings/connections",
  keys: "/settings/api-keys",
  integrations: "/settings/integrations",
  repos: "/settings/repos",
  debug: "/settings/debug",
  metrics: "/usage/metrics",
  // The standalone script-runs list folded into the Scripts page's Runs tab.
  "script-runs": "/scripts?tab=runs",
};

const REDIRECT = unlisted("redirect", { searchOptOut: "redirect" });

const redirectRoutes: RouteObject[] = [
  ...Object.entries(REDIRECTS).map(([from, to]) => ({
    path: from,
    element: <Navigate to={to} replace />,
    handle: REDIRECT,
  })),
  {
    path: "integrations/:id",
    element: <RouteRedirect to={({ id }) => `/settings/integrations/${id}`} />,
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
      { path: "tasks/:id", element: <TaskDetailPage /> },
      { path: "tasks/:id/lineage", element: <TaskLineagePage /> },
      // One page for both paths (as chat does), so the sessions v2 shell stays
      // mounted when the focused session changes. It also picks the legacy pages.
      {
        path: "sessions",
        element: <SessionsPage />,
        handle: nav(
          { title: "Sessions", icon: MessageSquare, minVersion: "1.76.0" },
          { searchOptOut: "the sessions page adds its own palette group" },
        ),
      },
      { path: "sessions/:rootTaskId", element: <SessionsPage /> },
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
      {
        path: "connections",
        element: <ScriptConnectionsPage />,
        handle: nav(
          {
            title: "Connections",
            icon: Link2,
            keywords: ["script", "oauth", "api"],
            adminOnly: true,
          },
          { searchOptOut: "the script-connections API has no search yet" },
        ),
      },
      { path: "connections/oauth-apps/:id", element: <OAuthAppDetailPage /> },
      { path: "connections/:id", element: <ScriptConnectionDetailPage /> },
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
            handle: nav({ title: "Swarm connections", icon: Network, parent: "Settings" }),
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
          {
            path: "api-keys",
            element: admin(<ApiKeysPage />),
            handle: nav({
              title: "Provider keys",
              icon: Key,
              parent: "Settings",
              keywords: ["api keys"],
              adminOnly: true,
            }),
          },
          {
            path: "integrations",
            element: admin(<IntegrationsPage />),
            handle: nav(
              {
                title: "Integrations",
                icon: Plug,
                parent: "Settings",
                keywords: ["slack", "github", "linear", "jira"],
                adminOnly: true,
              },
              { searchOptOut: "a fixed catalog listed on the page" },
            ),
          },
          { path: "integrations/:id", element: admin(<IntegrationDetailPage />) },
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
        path: "templates",
        element: <TemplatesPage />,
        handle: nav(
          { title: "Templates", icon: FileText, keywords: ["prompt templates"], adminOnly: true },
          { searchOptOut: "the prompt-templates API has no search yet" },
        ),
      },
      { path: "templates/:id", element: <TemplateDetailPage /> },
      { path: "templates/:id/history/:version", element: <TemplateVersionDetailPage /> },
      {
        path: "mcp-servers",
        element: <McpServersPage />,
        handle: nav(
          { title: "MCP servers", icon: Cable, adminOnly: true },
          { search: ["mcp-servers"] },
        ),
      },
      { path: "mcp-servers/:id", element: <McpServerDetailPage /> },
      {
        path: "skills",
        element: <SkillsPage />,
        handle: nav({ title: "Skills", icon: BookOpen, adminOnly: true }, { search: ["skills"] }),
      },
      { path: "skills/:id", element: <SkillDetailPage /> },
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
        handle: nav({ title: "Apps", icon: LayoutGrid, adminOnly: true }, { search: ["apps"] }),
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
      ...devRoutes,
      ...redirectRoutes,
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];
