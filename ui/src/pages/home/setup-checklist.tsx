/**
 * Phase 4: Setup checklist for the home page.
 *
 * Extracted from `page.tsx` so the per-row collapse + tour-completion
 * collapse logic can hold local state without bloating the page module.
 *
 * Persistence layer is `useDismissibleCard` (per-deployment localStorage).
 *
 * Behavior:
 *   - Each `verified` row gets a chevron toggle. Collapsing hides the
 *     hint + state pill; the row keeps its label, check icon, and the
 *     "View" CTA. Non-verified rows stay always-expanded — the user
 *     needs the hint visible to know what to do.
 *   - When all four MVP milestones (`harness`, ANY integration, `workers`,
 *     `first_task`) have flipped to `verified` at least once, the entire
 *     section collapses to a single "Show setup" toggle. The
 *     "tour-complete" flag is sticky: once set it stays set even if a
 *     milestone later regresses (avoids the "re-expanded after a flake"
 *     UX bug).
 *
 * No automated UI tests for this file — `ui/` has no test runner. See
 * the qa-use sessions in the plan's Success Criteria.
 */

import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useTestConnection } from "@/api/hooks";
import type { ProviderName, SetupMilestone, SetupMilestoneState } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useDismissibleCard } from "@/hooks/use-dismissible-card";
import { cn } from "@/lib/utils";

const DOCS_URL = "https://docs.agent-swarm.dev/docs";

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

  // Per-row collapse — only meaningful when state === "verified". For
  // other states the row stays expanded regardless of the dismissible
  // flag (the user needs the hint visible).
  const { dismissed, dismiss, restore } = useDismissibleCard(`setup:row:${milestone.id}`);
  const collapsible = milestone.state === "verified";
  const collapsed = collapsible && dismissed;

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

  const toggleCollapse = () => {
    if (!collapsible) return;
    if (collapsed) restore();
    else dismiss();
  };

  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-border last:border-b-0">
      <div className="flex items-start gap-3 min-w-0">
        {collapsible ? (
          <button
            type="button"
            onClick={toggleCollapse}
            aria-label={collapsed ? `Expand ${milestone.label}` : `Collapse ${milestone.label}`}
            aria-expanded={!collapsed}
            className="mt-0.5 shrink-0 inline-flex items-center justify-center rounded-sm hover:bg-muted/50 -ml-1 px-1 py-0.5"
          >
            <span className="inline-flex items-center gap-1">
              {collapsed ? (
                <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
              ) : (
                <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
              )}
              <StateIcon state={milestone.state} />
            </span>
          </button>
        ) : (
          <div className="mt-0.5 shrink-0">
            <StateIcon state={milestone.state} />
          </div>
        )}
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{milestone.label}</span>
            {!collapsed ? (
              <Badge variant="outline" size="tag" className={cn(STATE_TONE_CLASS[milestone.state])}>
                {STATE_LABEL[milestone.state]}
              </Badge>
            ) : null}
          </div>
          {!collapsed && milestone.hint ? (
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

// ─── Tour-completion gate ────────────────────────────────────────────────────

/**
 * The MVP milestones we surface in the home checklist: harness, any
 * integration verified, first_task. We treat the "any integration" leg as
 * verified iff at least one of {slack, github, linear, jira} is verified.
 *
 * `workers` is intentionally not part of this gate — fleet status is
 * tracked elsewhere (header / dashboard) and shouldn't gate the home tour.
 */
function isTourComplete(setup: SetupMilestone[]): boolean {
  const byId = new Map(setup.map((m) => [m.id, m]));
  const harnessOk = byId.get("harness")?.state === "verified";
  const firstTaskOk = byId.get("first_task")?.state === "verified";
  const anyIntegrationOk = (["slack", "github", "linear", "jira"] as const).some(
    (id) => byId.get(id)?.state === "verified",
  );
  return harnessOk && firstTaskOk && anyIntegrationOk;
}

// ─── SetupChecklist ──────────────────────────────────────────────────────────

export interface SetupChecklistProps {
  setup: SetupMilestone[];
  harnessProvider: ProviderName | null;
}

export function SetupChecklist({ setup, harnessProvider }: SetupChecklistProps) {
  const navigate = useNavigate();

  const harnessRow = setup.find((m) => m.id === "harness");
  const slackRow = setup.find((m) => m.id === "slack");
  const githubRow = setup.find((m) => m.id === "github");
  const firstTaskRow = setup.find((m) => m.id === "first_task");

  // Tour-completion flag — sticky once set. The first time the user
  // satisfies all four MVP milestones, we flip the flag; from then on
  // the section collapses by default. The user can still toggle "Show
  // setup" / "Hide setup" manually.
  const {
    dismissed: tourDismissed,
    dismiss: dismissTour,
    restore: restoreTour,
  } = useDismissibleCard("setup:tour-complete");
  const tourSatisfied = isTourComplete(setup);

  useEffect(() => {
    if (tourSatisfied && !tourDismissed) {
      dismissTour();
    }
  }, [tourSatisfied, tourDismissed, dismissTour]);

  const sectionCollapsed = tourDismissed;

  return (
    <section id="setup" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
          Setup checklist
        </h2>
        {tourDismissed || tourSatisfied ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-xs h-auto py-1"
            onClick={() => (sectionCollapsed ? restoreTour() : dismissTour())}
            aria-expanded={!sectionCollapsed}
          >
            {sectionCollapsed ? (
              <>
                <ChevronRight className="h-3 w-3 mr-1" aria-hidden="true" /> Show setup
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3 mr-1" aria-hidden="true" /> Hide setup
              </>
            )}
          </Button>
        ) : null}
      </div>
      {sectionCollapsed ? (
        <Card>
          <CardContent className="px-4 py-3 text-xs text-muted-foreground flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-status-success" aria-hidden="true" />
            <span>All four setup milestones verified — your swarm is fully configured.</span>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {harnessRow ? (
              <SetupRow milestone={harnessRow} harnessProvider={harnessProvider} />
            ) : null}

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
                onClick={() => navigate("/settings/integrations")}
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

            {firstTaskRow ? <SetupRow milestone={firstTaskRow} harnessProvider={null} /> : null}
          </CardContent>
        </Card>
      )}
    </section>
  );
}
