import {
  Activity,
  Bot,
  Brain,
  Bug,
  ChartLine,
  Cloud,
  GitBranch,
  Github,
  GitMerge,
  KeyRound,
  ListChecks,
  type LucideIcon,
  Mail,
  MessageSquare,
  Plug,
  Route,
  Sparkles,
  SquareCheckBig,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { IntegrationDef } from "@/lib/integrations-catalog";
import type { IntegrationStatus } from "@/lib/integrations-status";
import { cn } from "@/lib/utils";
import { IntegrationStatusBadge } from "./integration-status-badge";

// Icon lookup keyed by `IntegrationDef.iconKey` (kebab-case in the catalog).
// Falls back to a generic `Plug` icon when a key isn't mapped — keeps the UI
// rendering even if the catalog gains a new entry before this map is updated.
const ICON_MAP: Record<string, LucideIcon> = {
  "message-square": MessageSquare,
  github: Github,
  "git-merge": GitMerge,
  "git-branch": GitBranch,
  "square-check-big": SquareCheckBig,
  "list-checks": ListChecks,
  activity: Activity,
  bug: Bug,
  mail: Mail,
  brain: Brain,
  sparkles: Sparkles,
  bot: Bot,
  route: Route,
  "key-round": KeyRound,
  "chart-line": ChartLine,
  cloud: Cloud,
};

function resolveIcon(iconKey: string): LucideIcon {
  return ICON_MAP[iconKey] ?? Plug;
}

interface IntegrationCardProps {
  def: IntegrationDef;
  status: IntegrationStatus;
  className?: string;
}

export function IntegrationCard({ def, status, className }: IntegrationCardProps) {
  const Icon = resolveIcon(def.iconKey);

  return (
    <Card
      className={cn(
        "flex flex-col gap-3 py-4 transition-colors hover:border-primary/40",
        className,
      )}
      data-integration-id={def.id}
    >
      <CardContent className="flex flex-1 flex-col gap-3 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted/50 shrink-0">
              <Icon className="h-5 w-5 text-foreground" aria-hidden="true" />
            </div>
            <h3 className="text-sm font-semibold truncate">{def.name}</h3>
          </div>
          <IntegrationStatusBadge status={status} />
        </div>

        <p className="text-xs text-muted-foreground line-clamp-2 flex-1">{def.description}</p>

        <div className="flex items-center justify-end pt-1">
          <Button asChild size="sm" variant="outline" className="gap-1">
            <Link to={`/integrations/${def.id}`} aria-label={`Configure ${def.name}`}>
              Configure →
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
