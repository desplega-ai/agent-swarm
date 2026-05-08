/**
 * Home page (Phase 1) — `/`.
 *
 * Driven by `GET /status`. Layout (top → bottom):
 *   1. Activity strip (3 stat tiles)
 *   2. Setup checklist:
 *        - Harness row
 *        - Integrations sub-section (Slack + GitHub) with "All integrations →"
 *          and "Docs ↗" links
 *        - Workers row
 *        - First task row
 *   3. First Steps + Storage placeholders (2-col on md+)
 *
 * Identity (org name + logo) lives in the sidebar header — not on this page.
 *
 * If `/status` returns 404 (older API server), this page renders nothing — the
 * router falls back to the legacy dashboard. The sidebar's Home item is also
 * hidden in that case (see `app-sidebar.tsx`).
 *
 * Power-user landing (live agents grid + activity feed) lives at `/dashboard`.
 */

import {
  ArrowRight,
  CheckCircle2,
  Circle,
  CircleDashed,
  Crown,
  ExternalLink,
  ListTodo,
  Loader2,
  Users,
} from "lucide-react";
import { Suspense } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useStatus, useTestConnection } from "@/api/hooks";
import type { ProviderName, SetupMilestone, SetupMilestoneState } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatPanel } from "@/components/ui/stat-panel";
import { cn } from "@/lib/utils";

const DOCS_URL = "https://docs.agent-swarm.dev/docs";
const AGENT_FS_URL = "https://agent-fs.dev";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATE_LABEL: Record<SetupMilestoneState, string> = {
  unverified: "Not set up",
  configured: "Set up",
  verified: "Verified",
};

const STATE_TONE_CLASS: Record<SetupMilestoneState, string> = {
  unverified: "border-status-neutral/40 text-status-neutral-strong",
  configured: "border-status-pending/40 text-status-pending-strong",
  verified: "border-status-success/40 text-status-success-strong",
};

function StateIcon({ state }: { state: SetupMilestoneState }) {
  if (state === "verified") {
    return <CheckCircle2 className="h-4 w-4 text-status-success" aria-hidden="true" />;
  }
  if (state === "configured") {
    return <CircleDashed className="h-4 w-4 text-status-pending" aria-hidden="true" />;
  }
  return <Circle className="h-4 w-4 text-status-neutral" aria-hidden="true" />;
}

/**
 * Per-milestone CTA copy. Generic "Set up" was misaligned with the actual
 * action on most rows.
 */
function ctaLabel(milestone: SetupMilestone): string {
  if (milestone.state === "verified") return "View";
  switch (milestone.id) {
    case "slack":
    case "github":
    case "linear":
    case "jira":
      return "Connect";
    case "workers":
      return "Read docs";
    case "first_task":
      return "Create task";
    default:
      return "Set up";
  }
}

// ─── Setup row ───────────────────────────────────────────────────────────────

function SetupRow({
  milestone,
  harnessProvider,
}: {
  milestone: SetupMilestone;
  harnessProvider: ProviderName | null;
}) {
  const navigate = useNavigate();
  const testMutation = useTestConnection();
  const isHarnessConfigured = milestone.id === "harness" && milestone.state === "configured";

  const handleAction = () => {
    if (!milestone.action_url) return;
    navigate(milestone.action_url);
  };

  const handleTestConnection = () => {
    if (!harnessProvider) return;
    testMutation.mutate(harnessProvider, {
      onSuccess: (result) => {
        if (result.ok) {
          toast.success(`Verified harness — ${result.latency_ms} ms.`);
        } else {
          toast.error(`Test failed: ${result.error ?? "unknown error"}`, {
            description: `Provider: ${harnessProvider} • ${result.latency_ms} ms`,
          });
        }
      },
      onError: (err) => {
        toast.error(err instanceof Error ? err.message : "Failed to test connection.");
      },
    });
  };

  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-border last:border-b-0">
      <div className="flex items-start gap-3 min-w-0">
        <div className="mt-0.5 shrink-0">
          <StateIcon state={milestone.state} />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{milestone.label}</span>
            <Badge variant="outline" size="tag" className={cn(STATE_TONE_CLASS[milestone.state])}>
              {STATE_LABEL[milestone.state]}
            </Badge>
          </div>
          {milestone.hint ? (
            <p className="text-xs text-muted-foreground">{milestone.hint}</p>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {isHarnessConfigured && harnessProvider ? (
          <Button
            size="sm"
            variant="outline"
            onClick={handleTestConnection}
            disabled={testMutation.isPending}
          >
            {testMutation.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              "Test connection"
            )}
          </Button>
        ) : null}
        {milestone.action_url ? (
          <Button size="sm" variant="ghost" onClick={handleAction}>
            {ctaLabel(milestone)}
            {milestone.state !== "verified" ? <ArrowRight className="ml-1 h-3 w-3" /> : null}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

function HomePageContent() {
  const navigate = useNavigate();
  const { data: status, isLoading, error } = useStatus();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading swarm status…
      </div>
    );
  }

  // /status returned 404 (older API), threw any other error, or otherwise
  // came back empty — fall back to the legacy dashboard so the user always
  // lands on a working page.
  if (status === null || error || !status) {
    return <Navigate to="/dashboard" replace />;
  }

  const { setup, activity, agent_fs } = status;

  // Phase 1.5: read the harness provider from the typed milestone field.
  const harnessRow = setup.find((m) => m.id === "harness");
  const provider: ProviderName | null = harnessRow?.provider ?? null;

  const slackRow = setup.find((m) => m.id === "slack");
  const githubRow = setup.find((m) => m.id === "github");
  const workersRow = setup.find((m) => m.id === "workers");
  const firstTaskRow = setup.find((m) => m.id === "first_task");

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="flex flex-col gap-6 max-w-5xl mx-auto w-full pb-8">
        {/* Activity */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
            Activity
          </h2>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-3">
            <StatPanel
              icon={Crown}
              label="Leads online"
              value={activity.leads_online}
              tone={activity.leads_online > 0 ? "success" : "neutral"}
            />
            <StatPanel
              icon={Users}
              label="Agents online"
              value={activity.agents_online}
              tone={activity.agents_online > 0 ? "active" : "neutral"}
            />
            <StatPanel
              icon={ListTodo}
              label="Tasks (24h)"
              value={activity.recent_tasks_count}
              tone={activity.recent_tasks_count > 0 ? "info" : "neutral"}
            />
          </div>
        </section>

        {/* Setup checklist */}
        <section id="setup" className="space-y-2">
          <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
            Setup checklist
          </h2>
          <Card>
            <CardContent className="p-0">
              {harnessRow ? <SetupRow milestone={harnessRow} harnessProvider={provider} /> : null}

              {/* Integrations sub-group */}
              <div className="px-4 py-2 bg-muted/30 border-b border-border">
                <p className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
                  Integrations
                </p>
              </div>
              {slackRow ? <SetupRow milestone={slackRow} harnessProvider={null} /> : null}
              {githubRow ? <SetupRow milestone={githubRow} harnessProvider={null} /> : null}
              <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/10">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => navigate("/integrations")}
                  className="text-xs"
                >
                  All integrations <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
                <a
                  href={`${DOCS_URL}/integrations`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                >
                  Docs <ExternalLink className="h-3 w-3" />
                </a>
              </div>

              {workersRow ? <SetupRow milestone={workersRow} harnessProvider={null} /> : null}
              {firstTaskRow ? <SetupRow milestone={firstTaskRow} harnessProvider={null} /> : null}
            </CardContent>
          </Card>
        </section>

        {/* First Steps + Storage — two columns on md+ */}
        <section className="grid gap-4 grid-cols-1 md:grid-cols-2">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
              First steps
            </h2>
            <Card>
              <CardContent className="p-4 text-sm text-muted-foreground">
                Recommended starter templates will appear here once you connect an integration. For
                now, head to the templates page to browse what's available.
              </CardContent>
            </Card>
          </div>

          <div className="space-y-2">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
              Storage
            </h2>
            <Card>
              <CardContent className="p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {agent_fs.configured ? "agent-fs configured" : "agent-fs not configured"}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {agent_fs.configured
                      ? `Base URL: ${agent_fs.base_url}`
                      : "Set AGENT_FS_API_URL to enable shared file storage."}
                  </p>
                </div>
                {agent_fs.configured && agent_fs.base_url ? (
                  <Button asChild size="sm" variant="outline">
                    <a href={agent_fs.base_url} target="_blank" rel="noopener noreferrer">
                      Open <ExternalLink className="ml-1 h-3 w-3" />
                    </a>
                  </Button>
                ) : (
                  <Button asChild size="sm" variant="outline">
                    <a href={AGENT_FS_URL} target="_blank" rel="noopener noreferrer">
                      Set up <ExternalLink className="ml-1 h-3 w-3" />
                    </a>
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>
        </section>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
        </div>
      }
    >
      <HomePageContent />
    </Suspense>
  );
}
