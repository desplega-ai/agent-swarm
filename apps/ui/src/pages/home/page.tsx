/**
 * Home page (Phase 1, with Phase 3/4 layers) — `/`.
 *
 * Driven by `GET /status`. Layout (top → bottom):
 *   1. Welcome card (Phase 4 — dismissible, per-deployment localStorage)
 *   2. Activity strip (3 stat tiles)
 *   3. Setup checklist (extracted to `setup-checklist.tsx` in Phase 4 for
 *      per-row + tour-completion collapse)
 *   4. First Steps + Storage (2-col on md+)
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
  Crown,
  ExternalLink,
  ListTodo,
  Loader2,
  MessageSquarePlus,
  Sparkles,
  X,
} from "lucide-react";
import { Suspense, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import type { ProviderName, SetupMilestone, StatusResponse } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatPanel } from "@/components/ui/stat-panel";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useDismissibleCard } from "@/hooks/use-dismissible-card";
import {
  detectedFromStatus,
  type TemplateId,
  topRecommendation,
} from "@/lib/template-recommendations";
import { SetupChecklist } from "./setup-checklist";

const AGENT_FS_URL = "https://agent-fs.dev";

// ─── Welcome card (Phase 4) ──────────────────────────────────────────────────

/**
 * Org-aware intro card shown once per deployment. Dismissible via
 * `useDismissibleCard("home-welcome")` — choice persists across reloads
 * and tabs of the same `apiUrl`.
 */
function WelcomeCard({ status }: { status: StatusResponse }) {
  const { dismissed, dismiss } = useDismissibleCard("home-welcome");
  // Phase 3 (Important-I4): defer the welcome card until the identity context
  // resolves. Otherwise a first-time visitor sees the identity modal stacked
  // over a fully-rendered page; keeping the card hidden until `state === "ready"`
  // gives them a clean two-step boot (modal → home with welcome).
  const { state: identityState } = useCurrentUser();
  if (identityState !== "ready") return null;
  if (dismissed) return null;
  const orgName = status.identity.name || "Swarm";
  return (
    <Card>
      <CardContent className="p-4 flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">Welcome to {orgName}!</p>
          <p className="text-xs text-muted-foreground">
            This is your swarm home. Track setup, kick off your first task, and watch live activity.
            Each card below maps to a setup milestone — finish them to graduate.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={dismiss}
          aria-label="Dismiss welcome card"
          className="shrink-0"
        >
          <X className="h-3 w-3" aria-hidden="true" />
          <span className="ml-1 text-xs">Got it</span>
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── New-session shortcut ────────────────────────────────────────────────────

/**
 * Always-visible CTA card that drops you straight into a new session. The
 * input is a passive prompt — pressing Enter or clicking the button forwards
 * the typed text to `/sessions` via a query param, which the new-session
 * composer reads on mount.
 */
function NewSessionShortcut() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const submit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      navigate("/sessions");
      return;
    }
    navigate(`/sessions?seed=${encodeURIComponent(trimmed)}`);
  };
  return (
    <Card className="border-primary/30 bg-primary/[0.04]">
      <CardContent className="p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <MessageSquarePlus className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-semibold">What do you have in mind?</h2>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Investigate a flaky test, draft a spec, kick off a research crew…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Describe what you want the swarm to do"
          />
          <Button type="submit" size="sm">
            Start session <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

function HomePageContent() {
  // Phase 2: read from the shared StatusProvider so polling is centralized
  // (the AppHeader badge, AppFooter, sidebar identity, and home all share
  // the same /status snapshot).
  const { data: status, isLoading, error } = useStatusContext();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading swarm status…
      </div>
    );
  }

  // /status returned 404 (older API), threw any other error, or otherwise
  // came back empty — fall back to the legacy dashboard so the user always
  // lands on a working page. The legacy dashboard now lives at /old-dashboard
  // (the IA rework moved the new unified Home to /).
  if (status === null || error || !status) {
    return <Navigate to="/old-dashboard" replace />;
  }

  const { setup, activity, agent_fs } = status;

  // Phase 1.5: read the harness provider from the typed milestone field.
  const harnessRow = setup.find((m) => m.id === "harness");
  const provider: ProviderName | null = harnessRow?.provider ?? null;
  const firstTaskRow = setup.find((m) => m.id === "first_task");

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="flex flex-col gap-6 max-w-5xl mx-auto w-full pb-8">
        {/* Welcome card (Phase 4) */}
        <WelcomeCard status={status} />

        {/* Quick-start session shortcut — primary CTA on the home page. */}
        <NewSessionShortcut />

        {/* Activity */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
            Activity
          </h2>
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            <StatPanel
              icon={Crown}
              label="Leads online"
              value={activity.leads_online}
              tone={activity.leads_online > 0 ? "success" : "neutral"}
            />
            <StatPanel
              icon={ListTodo}
              label="Tasks (24h)"
              value={activity.recent_tasks_count}
              tone={activity.recent_tasks_count > 0 ? "info" : "neutral"}
            />
          </div>
        </section>

        {/* Setup checklist (Phase 4: extracted, dismissible) */}
        <SetupChecklist setup={setup} harnessProvider={provider} />

        {/* First Steps + Storage — two columns on md+ */}
        <section className="grid gap-4 grid-cols-1 md:grid-cols-2">
          <div className="space-y-2">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
              First steps
            </h2>
            <FirstStepsCard status={status} firstTaskRow={firstTaskRow} />
          </div>

          <div className="space-y-2">
            <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
              Storage
            </h2>
            <Card>
              <CardContent className="p-4 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Active provider: {agent_fs.provider_id}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {agent_fs.configured
                      ? `Base URL: ${agent_fs.base_url}`
                      : "Using local-fs. Set AGENT_FS_API_URL; the API will seed agent-fs credentials."}
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

// ─── First-steps recommendation card ─────────────────────────────────────────

const TEMPLATE_LABELS: Record<TemplateId, string> = {
  "pr-triage": "PR triage",
  "issue-to-pr": "Issue → PR",
  "bug-intake": "Bug intake",
  "hello-world": "Hello world",
};

/**
 * Phase 3: home "First steps" section. Shows the top template recommendation
 * derived from `/status`'s detected integrations.
 *
 * - When `first_task.state === "verified"`: collapse to a small link to
 *   `/templates`. The user has already finished their first task — no need
 *   to keep nagging.
 * - Otherwise: full CTA card with the template recommendation. Primary
 *   action wires through `first_task.action_url` (defaults to
 *   `/tasks?new=true` server-side) so clicking opens the create-task
 *   dialog. Secondary action goes to `/templates` to browse alternatives.
 */
function FirstStepsCard({
  status,
  firstTaskRow,
}: {
  status: StatusResponse;
  firstTaskRow: SetupMilestone | undefined;
}) {
  const navigate = useNavigate();
  const rec = topRecommendation(status);
  const detectedCount = detectedFromStatus(status).size;
  const templateLabel = TEMPLATE_LABELS[rec.templateId];

  if (firstTaskRow?.state === "verified") {
    return (
      <Card>
        <CardContent className="p-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">First task done — nice.</p>
            <p className="text-xs text-muted-foreground">
              Browse more templates to expand what your swarm can do.
            </p>
          </div>
          <Button asChild size="sm" variant="ghost">
            <a href="/templates">
              Recommended templates <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
            </a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const primaryHref = firstTaskRow?.action_url ?? "/tasks?new=true";
  return (
    <Card>
      <CardContent className="p-4 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-status-active" aria-hidden="true" />
          <span className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
            Recommended template
          </span>
          {detectedCount === 0 ? (
            <Badge variant="outline" size="tag" className="ml-auto">
              No integrations
            </Badge>
          ) : null}
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Start with {templateLabel}</p>
          <p className="text-xs text-muted-foreground">{rec.reason}</p>
        </div>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button size="sm" variant="ghost" onClick={() => navigate("/templates")}>
            Browse all
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-template-id={rec.templateId}
            onClick={() => navigate(primaryHref)}
          >
            Create task <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
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
