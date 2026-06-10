/**
 * Phase 3: Renders a "try this template to get going" card based on the
 * top recommendation derived from `/status`. Used by the empty states on
 * `/templates`, `/tasks`, `/workflows` and the home "First steps" section.
 *
 * The card is presentational — the parent decides when to show it. Click
 * routes to `/templates` (the prompt-templates list). A future iteration
 * may deep-link to a per-template detail view once the agent-template
 * registry is exposed in the UI; for now we keep the navigation honest.
 */

import { ArrowRight, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useStatusContext } from "@/app/status-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  detectedFromStatus,
  type Recommendation,
  type TemplateId,
  topRecommendation,
} from "@/lib/template-recommendations";

const TEMPLATE_LABELS: Record<TemplateId, string> = {
  "pr-triage": "PR triage",
  "issue-to-pr": "Issue → PR",
  "bug-intake": "Bug intake",
  "hello-world": "Hello world",
};

export interface TemplateRecommendationCardProps {
  /**
   * Optional eyebrow text rendered above the headline (e.g. "Suggested for
   * you", "Try this", "Recommended"). Defaults to "Recommended template".
   */
  eyebrow?: string;
  /** Override the action target (defaults to `/templates`). */
  actionHref?: string;
  /** Override the action label (defaults to "Browse templates"). */
  actionLabel?: string;
  /** Hide the eyebrow/badge when embedded in a section that already has a heading. */
  compact?: boolean;
}

/**
 * Reads `/status` from the shared context. If `/status` is unavailable
 * (loading, errored, or older API returned 404), renders nothing — empty
 * states stay generic.
 *
 * TODO(taras): Refactor this to be actually useful,
 * redirecting to templates is useless
 */
export function TemplateRecommendationCard({
  eyebrow = "Recommended template",
  actionHref = "/templates",
  actionLabel = "Browse templates",
  compact = false,
}: TemplateRecommendationCardProps) {
  const { data: status } = useStatusContext();
  if (!status) return null;
  const rec = topRecommendation(status);
  return (
    <RecommendationCardInner
      rec={rec}
      eyebrow={eyebrow}
      actionHref={actionHref}
      actionLabel={actionLabel}
      compact={compact}
      detectedCount={detectedFromStatus(status).size}
    />
  );
}

function RecommendationCardInner({
  rec,
  eyebrow,
  actionHref,
  actionLabel,
  compact,
  detectedCount,
}: {
  rec: Recommendation;
  eyebrow: string;
  actionHref: string;
  actionLabel: string;
  compact: boolean;
  detectedCount: number;
}) {
  const navigate = useNavigate();
  const label = TEMPLATE_LABELS[rec.templateId];
  return (
    <Card className="max-w-xl mx-auto w-full">
      <CardContent className="p-5 flex flex-col gap-3">
        {!compact ? (
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-status-active" aria-hidden="true" />
            <span className="text-xs font-semibold uppercase text-muted-foreground tracking-wide">
              {eyebrow}
            </span>
            {detectedCount === 0 ? (
              <Badge variant="outline" size="tag" className="ml-auto">
                No integrations
              </Badge>
            ) : null}
          </div>
        ) : null}
        <div className="space-y-1">
          <p className="text-sm font-medium">Start with {label}</p>
          <p className="text-xs text-muted-foreground">{rec.reason}</p>
        </div>
        <div className="flex items-center justify-end pt-1">
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate(actionHref)}
            data-template-id={rec.templateId}
          >
            {actionLabel}
            <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
