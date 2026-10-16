import type { LucideIcon } from "lucide-react";
import { ArrowUpCircle, BarChart3, ExternalLink, Wrench, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useEnableTelemetry } from "@/api/hooks/use-org-profile";
import { useStatusContext } from "@/app/status-context";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { useDismissibleCard } from "@/hooks/use-dismissible-card";
import { deriveStorageKey } from "@/hooks/use-dismissible-card-key";
import { showTelemetryBanner, TELEMETRY_BANNER_CARD_KEY } from "@/lib/telemetry-banner";
import { isAdminLike } from "@/lib/user-role";
import { cn } from "@/lib/utils";
import { AutomationSetupRows } from "./automation-setup-rows";

const CURRENT_VERSION = __APP_VERSION__;
const TELEMETRY_DOCS_URL = "https://docs.agent-swarm.dev/docs/reference/telemetry";

function readDismissedAt(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

export function DashboardNudges() {
  const { user } = useCurrentUser();
  const { data: status } = useStatusContext();
  const upgradeGate = useFeatureGate(CURRENT_VERSION);
  const upgradeCard = useDismissibleCard(`dashboard-upgrade:${CURRENT_VERSION}`);
  const { config } = useConfig();
  const telemetryKey = deriveStorageKey(config.apiUrl, TELEMETRY_BANNER_CARD_KEY);
  const [telemetryDismissedAt, setTelemetryDismissedAt] = useState(() =>
    readDismissedAt(telemetryKey),
  );
  const enableTelemetry = useEnableTelemetry();

  if (!isAdminLike(user)) return null;

  const showTelemetry = showTelemetryBanner({
    telemetryEnabled: status?.telemetry?.enabled,
    isAdmin: true,
    dismissedAt: telemetryDismissedAt,
  });
  function dismissTelemetry() {
    const now = new Date().toISOString();
    try {
      localStorage.setItem(telemetryKey, now);
    } catch {
      // In-memory dismissal still hides it for this session.
    }
    setTelemetryDismissedAt(now);
  }

  const showUpgrade =
    upgradeGate.currentVersion !== null && !upgradeGate.supported && !upgradeCard.dismissed;
  const waitingAutomations = status?.automations?.filter(
    (automation) => automation.state === "needs_setup",
  );
  const showAutomations = (waitingAutomations?.length ?? 0) > 0;

  if (!showUpgrade && !showAutomations && !showTelemetry) return null;

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
          title="Update available"
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

      {showTelemetry && (
        <NudgeBanner
          priority="secondary"
          icon={BarChart3}
          title="Telemetry is off"
          description={
            <>
              Turn it on to send usage counts, never prompts or task content. You get a benchmark
              against similar swarms and faster fixes; we see which features matter.{" "}
              <a
                href={TELEMETRY_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                What we collect
              </a>
            </>
          }
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={enableTelemetry.isPending}
              onClick={() =>
                enableTelemetry.mutate("banner", {
                  onError: () => toast.error("Could not turn telemetry on. Please try again."),
                })
              }
            >
              {enableTelemetry.isPending ? "Turning on…" : "Turn on"}
            </Button>
          }
          onDismiss={dismissTelemetry}
        />
      )}
    </div>
  );
}

export function NudgeBanner({
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
  description?: ReactNode;
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
            <p className="truncate text-sm font-medium leading-snug text-foreground sm:shrink-0">
              {title}
            </p>
            {description && <div className="text-sm text-muted-foreground">{description}</div>}
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
