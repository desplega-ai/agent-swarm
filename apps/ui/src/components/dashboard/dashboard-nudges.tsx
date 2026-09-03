import type { LucideIcon } from "lucide-react";
import { ArrowUpCircle, Building2, ExternalLink, X } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "@/components/ui/card";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useDismissibleCard } from "@/hooks/use-dismissible-card";
import { cn } from "@/lib/utils";

const CURRENT_VERSION = __APP_VERSION__;
const ORG_NAME_KEY = "SWARM_ORG_NAME";

export function DashboardNudges() {
  const { user } = useCurrentUser();
  const upgradeGate = useFeatureGate(CURRENT_VERSION);
  const { data: configs } = useConfigs({ scope: "global" });
  const upgradeCard = useDismissibleCard(`dashboard-upgrade:${CURRENT_VERSION}`);
  const orgNameCard = useDismissibleCard("dashboard-org-name");

  if (user?.role !== "admin") return null;

  const orgName = configs?.find((config) => config.key === ORG_NAME_KEY)?.value.trim();
  const showUpgrade =
    upgradeGate.currentVersion !== null && !upgradeGate.supported && !upgradeCard.dismissed;
  const showOrgName = configs !== undefined && !orgName && !orgNameCard.dismissed;

  if (!showUpgrade && !showOrgName) return null;

  return (
    <div className={cn("grid gap-3", showUpgrade && showOrgName && "md:grid-cols-2")}>
      {showUpgrade && upgradeGate.currentVersion && (
        <NudgeCard
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
                View release notes
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          }
          onDismiss={upgradeCard.dismiss}
        />
      )}

      {showOrgName && (
        <NudgeCard
          icon={Building2}
          title="Make this dashboard yours"
          description="Add your organization name so it appears in the dashboard, status page, and outbound messages."
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/settings/configuration?search=SWARM_ORG_NAME#setting-SWARM_ORG_NAME">
                Add organization name
              </Link>
            </Button>
          }
          onDismiss={orgNameCard.dismiss}
        />
      )}
    </div>
  );
}

function NudgeCard({
  icon: Icon,
  title,
  description,
  action,
  onDismiss,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  action: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <Card className="gap-4 border-primary/20 bg-primary/[0.025] py-4 shadow-none">
      <CardContent className="flex items-start gap-3 px-4 sm:px-5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
          <CardTitle className="text-sm">{title}</CardTitle>
          <CardDescription className="max-w-2xl leading-relaxed">{description}</CardDescription>
        </div>
        <div className="flex items-start gap-1">
          {action}
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
        </div>
      </CardContent>
    </Card>
  );
}
