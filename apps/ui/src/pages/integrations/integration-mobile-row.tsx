// mockup(ui-audit): integration cards were ~178px each on a phone, this is a ~64px row
// Page-local copy of the card's logo lookup: the real fix exports `resolveIcon`
// (or a `compact` variant) from components/integrations/integration-card.tsx.
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
  MessageCircle,
  MessageSquare,
  Mic,
  Plug,
  Route,
  Search,
  Sparkles,
  SquareCheckBig,
} from "lucide-react";
import { IntegrationStatusBadge } from "@/components/integrations/integration-status-badge";
import { BrandLogo } from "@/components/shared/brand-logo";
import { MobileListRow } from "@/components/shared/mobile-list";
import { ProviderIcon } from "@/components/shared/provider-icon";
import type { IntegrationDef } from "@/lib/integrations-catalog";
import type { IntegrationStatus } from "@/lib/integrations-status";

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
  mic: Mic,
};

export function IntegrationMobileRow({
  def,
  status,
}: {
  def: IntegrationDef;
  status: IntegrationStatus;
}) {
  const Icon = ICON_MAP[def.iconKey] ?? Plug;
  const logo = def.providerIconKey ? (
    <ProviderIcon provider={def.providerIconKey} className="h-4 w-4 text-foreground opacity-100" />
  ) : def.logoSrc ? (
    <BrandLogo src={def.logoSrc} className="size-4 text-foreground" />
  ) : (
    <Icon className="h-4 w-4 text-foreground" aria-hidden="true" />
  );

  return (
    <MobileListRow
      to={`/settings/integrations/${def.id}`}
      titleLines={1}
      leading={
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-muted/50">
          {logo}
        </span>
      }
      title={def.name}
      status={<IntegrationStatusBadge status={status} />}
      meta={[<span key="d">{def.description}</span>]}
    />
  );
}
