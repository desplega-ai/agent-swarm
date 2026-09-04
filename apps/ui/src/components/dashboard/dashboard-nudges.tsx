import type { LucideIcon } from "lucide-react";
import { ArrowUpCircle, Building2, ExternalLink, Wrench, X } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useStatusContext } from "@/app/status-context";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useDismissibleCard } from "@/hooks/use-dismissible-card";
import { cn } from "@/lib/utils";
import { AutomationSetupRows } from "./automation-setup-rows";

const CURRENT_VERSION = __APP_VERSION__;
const ORG_NAME_KEY = "SWARM_ORG_NAME";

export function DashboardNudges() {
  const { user } = useCurrentUser();
  const { data: status } = useStatusContext();
  const upgradeGate = useFeatureGate(CURRENT_VERSION);
  const { data: configs } = useConfigs({ scope: "global" });
  const upgradeCard = useDismissibleCard(`dashboard-upgrade:${CURRENT_VERSION}`);
  const orgNameCard = useDismissibleCard("dashboard-org-name");

  if (user?.role !== "admin") return null;

  const orgName = configs?.find((config) => config.key === ORG_NAME_KEY)?.value.trim();
  const showUpgrade =
    upgradeGate.currentVersion !== null && !upgradeGate.supported && !upgradeCard.dismissed;
  const showOrgName = configs !== undefined && !orgName && !orgNameCard.dismissed;
  const waitingAutomations = status?.automations.filter(
    (automation) => automation.state === "needs_setup",
  );
  const showAutomations = (waitingAutomations?.length ?? 0) > 0;

  if (!showUpgrade && !showOrgName && !showAutomations) return null;

  return (
    <div className="flex flex-col gap-2">
      {showAutomations && waitingAutomations && waitingAutomations.length > 0 && (
        <NudgeBanner
          priority="primary"
          icon={Wrench}
          title="Automations waiting on setup"
          description={<AutomationSetupRows automations={waitingAutomations} />}
        />
      )}

      {showUpgrade && upgradeGate.currentVersion && (
        <NudgeBanner
          priority="secondary"
          icon={ArrowUpCircle}
          title="A newer Agent Swarm version is available"
          description={
            <>
              This API is running <strong>v{upgradeGate.currentVersion}</strong>. The dashboard is
              built for <strong>v{CURRENT_VERSION}</strong>.
            </>
          }
          action={
            <Button asChild size="sm" variant="outline">
              <a
                href={`https://github.com/desplega-ai/agent-swarm/releases/tag/v${CURRENT_VERSION}`}
                target="_blank"
                rel="noreferrer"
              >
                <span className="hidden sm:inline">Release notes</span>
                <span className="sm:hidden">Notes</span>
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          }
          onDismiss={upgradeCard.dismiss}
        />
      )}

      {showOrgName && (
        <NudgeBanner
          priority="secondary"
          icon={Building2}
          title="Make this dashboard yours"
          description="Add your organization name so it appears in the dashboard, status page, and outbound messages."
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/settings/configuration?search=SWARM_ORG_NAME#setting-SWARM_ORG_NAME">
                <span className="hidden sm:inline">Add organization name</span>
                <span className="sm:hidden">Add name</span>
              </Link>
            </Button>
          }
          onDismiss={orgNameCard.dismiss}
        />
      )}
    </div>
  );
}

function NudgeBanner({
  priority,
  icon: Icon,
  title,
  description,
  action,
  onDismiss,
}: {
  priority: "primary" | "secondary";
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  const isPrimary = priority === "primary";

  return (
    <div
      className={cn(
        "w-full rounded-lg border px-3 py-2.5 shadow-none",
        isPrimary ? "border-primary/30 bg-primary/[0.04]" : "border-border/60 bg-muted/30",
      )}
    >
      <div className="flex items-start gap-2.5 sm:items-center">
        <div
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-xs",
            isPrimary ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
            <p className="text-sm font-medium leading-snug text-foreground">{title}</p>
            <div className="text-sm text-muted-foreground">{description}</div>
          </div>
        </div>

        {(action || onDismiss) && (
          <div className="flex shrink-0 items-start gap-1 sm:items-center">
            {action}
            {onDismiss && (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                onClick={onDismiss}
                aria-label={`Dismiss ${title}`}
                title="Dismiss"
              >
                <X aria-hidden="true" />
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
