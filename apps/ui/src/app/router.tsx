import { Suspense } from "react";
import { createBrowserRouter, Navigate, type RouteObject } from "react-router-dom";
import { RootLayout } from "@/components/layout/root-layout";
import { lazyRoute } from "@/components/shared/app-update-prompt";
import { HiveLoadingScreen } from "@/components/shared/hive-loading-screen";
import { SettingsLayout } from "@/pages/settings/settings-layout";
import { UsageLayout } from "@/pages/usage/usage-layout";
import { RouteRedirect } from "./route-redirect";

const UnifiedHome = lazyRoute(() => import("@/pages/home/unified-home"));
const AgentsPage = lazyRoute(() => import("@/pages/agents/page"));
const AgentDetailPage = lazyRoute(() => import("@/pages/agents/[id]/page"));
const TasksPage = lazyRoute(() => import("@/pages/tasks/page"));
const TaskDetailPage = lazyRoute(() => import("@/pages/tasks/[id]/page"));
const SessionsPage = lazyRoute(() => import("@/pages/sessions/page"));
const SessionDetailPage = lazyRoute(() => import("@/pages/sessions/[rootTaskId]/page"));
const ChatPage = lazyRoute(() => import("@/pages/chat/page"));
const ServicesPage = lazyRoute(() => import("@/pages/services/page"));
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
const ExtensionDetailPage = lazyRoute(() => import("@/pages/settings/extension-detail-page"));
const ExtensionCatalogPage = lazyRoute(() => import("@/pages/settings/extension-catalog-page"));
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
const SetupPage = lazyRoute(() => import("@/pages/setup/page"));
const ConnectPage = lazyRoute(() => import("@/pages/connect/page"));

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
  return [{ path: "dev/embed-test", element: <DevEmbedTestPage /> }];
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

const redirectRoutes: RouteObject[] = [
  ...Object.entries(REDIRECTS).map(([from, to]) => ({
    path: from,
    element: <Navigate to={to} replace />,
  })),
  {
    path: "integrations/:id",
    element: <RouteRedirect to={({ id }) => `/settings/integrations/${id}`} />,
  },
];

export const router = createBrowserRouter([
  // First-run onboarding: full page, outside the app shell (no sidebar/header).
  {
    path: "/setup",
    element: (
      <Suspense fallback={<HiveLoadingScreen />}>
        <SetupPage />
      </Suspense>
    ),
  },
  // Inbound handoff from the agent-swarm.dev connector. Also outside the app
  // shell: it opens as a fresh tab and must work with no connection yet.
  {
    path: "/connect",
    element: (
      <Suspense fallback={<HiveLoadingScreen />}>
        <ConnectPage />
      </Suspense>
    ),
  },
  {
    path: "/",
    element: <RootLayout />,
    children: [
      // `/` is served by `UnifiedHome` (pages/home/unified-home.tsx) — the sole
      // home surface. The former `/old-home` and `/old-dashboard` pages are gone.
      { index: true, element: <UnifiedHome /> },
      { path: "agents", element: <AgentsPage /> },
      { path: "agents/:id", element: <AgentDetailPage /> },
      { path: "tasks", element: <TasksPage /> },
      { path: "tasks/:id", element: <TaskDetailPage /> },
      { path: "sessions", element: <SessionsPage /> },
      { path: "sessions/:rootTaskId", element: <SessionDetailPage /> },
      { path: "chat", element: <ChatPage /> },
      { path: "chat/:channelId", element: <ChatPage /> },
      { path: "services", element: <ServicesPage /> },
      { path: "schedules", element: <SchedulesPage /> },
      { path: "schedules/:id", element: <ScheduleDetailPage /> },
      { path: "workflows", element: <WorkflowsPage /> },
      { path: "workflows/:id", element: <WorkflowDetailPage /> },
      { path: "workflow-runs/:id", element: <WorkflowRunDetailPage /> },
      { path: "connections", element: <ScriptConnectionsPage /> },
      { path: "connections/oauth-apps/:id", element: <OAuthAppDetailPage /> },
      { path: "connections/:id", element: <ScriptConnectionDetailPage /> },
      { path: "scripts", element: <ScriptsPage /> },
      { path: "scripts/:id", element: <ScriptDetailPage /> },
      { path: "script-runs/:id", element: <ScriptRunDetailPage /> },
      { path: "approval-requests", element: <ApprovalRequestsPage /> },
      { path: "approval-requests/:id", element: <ApprovalRequestDetailPage /> },
      {
        path: "usage",
        element: <UsageLayout />,
        children: [
          { index: true, element: <UsageContent /> },
          { path: "budgets", element: <BudgetsPage /> },
          { path: "metrics", element: <MetricsPage /> },
          { path: "metrics/:id", element: <MetricsPage /> },
        ],
      },
      {
        path: "settings",
        element: <SettingsLayout />,
        children: [
          { index: true, element: <Navigate to="/settings/connections" replace /> },
          { path: "config", element: <Navigate to="/settings/connections" replace /> },
          { path: "connections", element: <ConnectionsPage /> },
          { path: "appearance", element: <AppearancePage /> },
          { path: "secrets", element: <SecretsPage /> },
          { path: "api-keys", element: <ApiKeysPage /> },
          { path: "integrations", element: <IntegrationsPage /> },
          { path: "integrations/:id", element: <IntegrationDetailPage /> },
          { path: "configuration", element: <ConfigurationPage /> },
          { path: "extensions", element: <ExtensionsPage /> },
          { path: "extensions/new", element: <ExtensionCatalogPage /> },
          { path: "extensions/:id", element: <ExtensionDetailPage /> },
          { path: "repos", element: <ReposPage /> },
          { path: "debug", element: <DebugPage /> },
        ],
      },
      { path: "templates", element: <TemplatesPage /> },
      { path: "templates/:id", element: <TemplateDetailPage /> },
      { path: "templates/:id/history/:version", element: <TemplateVersionDetailPage /> },
      { path: "mcp-servers", element: <McpServersPage /> },
      { path: "mcp-servers/:id", element: <McpServerDetailPage /> },
      { path: "skills", element: <SkillsPage /> },
      { path: "skills/:id", element: <SkillDetailPage /> },
      { path: "repos/:id", element: <RepoDetailPage /> },
      { path: "people", element: <PeoplePage /> },
      { path: "people/unmapped", element: <PeoplePage /> },
      { path: "people/:id", element: <PersonDetailPage /> },
      { path: "memory", element: <MemoryPage /> },
      { path: "pages", element: <PagesListingPage /> },
      { path: "pages/:id", element: <PageDetailPage /> },
      { path: "apps", element: <AppsListingPage /> },
      { path: "apps/:id", element: <AppDetailPage /> },
      // A named page of a multi-page app. Same component as `apps/:id` (which
      // renders the app's `defaultPage`) — both URLs stay valid, no redirect.
      { path: "apps/:id/p/:page", element: <AppDetailPage /> },
      // Comb. `/file` redirects to the swarm drive once `/status` names it.
      { path: "file", element: <CombPage /> },
      { path: "file/~/:orgId/:driveId/*", element: <CombPage /> },
      ...devRoutes,
      ...redirectRoutes,
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);
