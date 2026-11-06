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
  HardDrive,
  KeyRound,
  ListChecks,
  type LucideIcon,
  Mail,
  MessageCircle,
  MessageSquare,
  Mic,
  Plug,
  Route,
  Search,
  Sparkles,
  SquareCheckBig,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BrandLogo } from "@/components/shared/brand-logo";
import { ProviderIcon } from "@/components/shared/provider-icon";
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
  "message-circle": MessageCircle,
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
  search: Search,
  "key-round": KeyRound,
  "chart-line": ChartLine,
  cloud: Cloud,
  "hard-drive": HardDrive,
  mic: Mic,
};

function resolveIcon(iconKey: string): LucideIcon {
  return ICON_MAP[iconKey] ?? Plug;
}

/**
 * An integration's mark: a provider glyph, then a full-colour logo image,
 * then a monochrome logo file, then the lucide icon. Decorative: the name
 * always renders next to it.
 */
export function IntegrationLogo({
  def,
  className = "size-5",
}: {
  def: Pick<IntegrationDef, "providerIconKey" | "logoImg" | "logoSrc" | "iconKey">;
  className?: string;
}) {
  if (def.providerIconKey) {
    return (
      <ProviderIcon
        provider={def.providerIconKey}
        className={cn(className, "text-foreground opacity-100")}
      />
    );
  }
  if (def.logoImg) {
    return (
      <img
        src={def.logoImg}
        alt=""
        aria-hidden
        className={cn(className, "rounded-[4px] object-contain")}
      />
    );
  }
  if (def.logoSrc)
    return <BrandLogo src={def.logoSrc} className={cn(className, "text-foreground")} />;
  const Icon = resolveIcon(def.iconKey);
  return <Icon className={cn(className, "text-foreground")} aria-hidden="true" />;
}

interface IntegrationCardProps {
  def: IntegrationDef;
  status: IntegrationStatus;
  className?: string;
  /** An account is signed in through OAuth: the chip reads "Connected". */
  connected?: boolean;
  /** Footer line left of the action (how it is connected, related links). */
  meta?: ReactNode;
  /** Action target. Defaults to the integration detail page. */
  href?: string;
  /** Action label. Defaults to "Configure →". */
  actionLabel?: string;
}

export function IntegrationCard({
  def,
  status,
  className,
  connected,
  meta,
  href = `/integrations/${def.id}`,
  actionLabel = "Configure →",
}: IntegrationCardProps) {
  const logo = <IntegrationLogo def={def} />;

  return (
    <Card
      interactive
      className={cn("flex flex-col gap-3 py-4", className)}
      data-integration-id={def.id}
    >
      <CardContent className="flex flex-1 flex-col gap-3 px-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted/50 shrink-0">
              {logo}
            </div>
            <h3 className="text-sm font-semibold truncate">{def.name}</h3>
          </div>
          <IntegrationStatusBadge status={status} connected={connected} />
        </div>

        <p className="text-xs text-muted-foreground line-clamp-2 flex-1">{def.description}</p>

        <div className="flex items-center justify-end gap-3 pt-1">
          {meta ? (
            <div className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{meta}</div>
          ) : null}
          <Button asChild size="sm" variant="outline" className="shrink-0 gap-1">
            <Link to={href} aria-label={`${actionLabel.replace(" →", "")} ${def.name}`}>
              {actionLabel}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
