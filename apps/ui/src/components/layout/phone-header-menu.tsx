import {
  ChevronRight,
  Ellipsis,
  Github,
  Lightbulb,
  ListChecks,
  MessageSquarePlus,
  Moon,
} from "lucide-react";
import { useState } from "react";
import { useHealth, useStats } from "@/api/hooks/use-stats";
import { useUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import { useStatusContext } from "@/app/status-context";
import { useContextPanel } from "@/components/context-panel/context-panel-state";
import { useContextPanelOffered } from "@/components/context-panel/context-session-panel";
import { userInitials } from "@/components/identity/user-switcher";
import { useWaitingImprovements } from "@/components/improvements/improvement-header-button";
import { ImprovementsSheet } from "@/components/improvements/improvements-sheet";
import { useSetupProgress } from "@/components/onboarding/setup-pill";
import { useResumeSetup } from "@/components/onboarding/use-resume-setup";
import {
  ActionSheet,
  ActionSheetItem,
  ActionSheetSeparator,
  ActionSheetSwitch,
} from "@/components/sessions-v2/mobile/action-sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { HEALTH_DOT_CLASS, HEALTH_LABEL, HealthPopoverBody } from "./health-badge";

const GITHUB_URL = "https://github.com/desplega-ai/agent-swarm";

/**
 * The phone header's one overflow button: the viewer's initials, as in the
 * sidebar (the page header's own "more" stays a plain ellipsis, so the two
 * never look alike). Its bottom sheet holds what the
 * desktop header shows inline: swarm health and dev mode, setup progress,
 * the session about this page, improvements, the theme and the GitHub link.
 * The health row opens the desktop health popover's details (failing checks,
 * "Stuck? Ask us") in a sheet of its own, so a healthy phone reaches them too.
 * A dot on the button says a row inside wants a person (drafts waiting,
 * setup unfinished). An unhealthy swarm keeps its own dot in the bar.
 */
export function PhoneHeaderMenu() {
  const [open, setOpen] = useState(false);
  const [improvementsOpen, setImprovementsOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const sendEvent = useUiTelemetry();
  const { theme, toggleTheme } = useTheme();
  const { data: status } = useStatusContext();
  const { data: health, isError } = useHealth();
  const stats = useStats();
  const panel = useContextPanel();
  const panelOffered = useContextPanelOffered();
  const waiting = useWaitingImprovements();
  const setup = useSetupProgress();
  const { resume } = useResumeSetup();
  const { user } = useCurrentUser();

  const isHealthy = Boolean(health) && !isError;
  const devMode = isHealthy && !stats.isError && stats.data?.devMode === true;
  // `/status` drives the label; older APIs without it fall back to `/health`.
  // A failed probe wins: the last `/status` snapshot predates the outage.
  const liveStatus = isError ? null : status;
  const healthLabel = liveStatus
    ? HEALTH_LABEL[liveStatus.health]
    : isHealthy
      ? "Connected"
      : "Disconnected";
  const healthDot = liveStatus
    ? HEALTH_DOT_CLASS[liveStatus.health]
    : isHealthy
      ? "bg-status-success"
      : "bg-status-error";
  const waitingCount = waiting?.length ?? 0;
  const attention = waitingCount > 0 || setup !== null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="relative size-11"
        aria-label={attention ? "Menu, needs attention" : "Menu"}
        onClick={() => setOpen(true)}
      >
        {user ? (
          // The sidebar's identity chip, one size up.
          <span
            aria-hidden="true"
            className="inline-flex size-7 items-center justify-center rounded-full bg-primary font-mono text-[11px] font-semibold text-primary-foreground shadow-sm"
          >
            {userInitials(user.name)}
          </span>
        ) : (
          <Ellipsis className="size-5" />
        )}
        {attention ? (
          <span
            aria-hidden="true"
            className="absolute top-2 right-2 size-2.5 rounded-full bg-status-warning ring-2 ring-background"
          />
        ) : null}
      </Button>
      <ActionSheet
        open={open}
        onOpenChange={setOpen}
        title={status?.identity.name ?? "Agent Swarm"}
      >
        {liveStatus ? (
          // `/status` carries the checks: the row opens their details.
          <button
            type="button"
            aria-label={`Swarm health: ${healthLabel}`}
            className="flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-base transition-colors active:bg-accent"
            onClick={() => {
              setOpen(false);
              setHealthOpen(true);
              sendEvent({ event: "feature.used", properties: { feature: "health_popover" } });
            }}
          >
            <HealthRowContent dot={healthDot} label={healthLabel} devMode={devMode} />
            <ChevronRight aria-hidden className="size-5 shrink-0 text-muted-foreground" />
          </button>
        ) : (
          <div className="flex min-h-12 items-center gap-3 px-3 text-base">
            <HealthRowContent dot={healthDot} label={healthLabel} devMode={devMode} />
          </div>
        )}
        {setup ? (
          <ActionSheetItem
            icon={ListChecks}
            label="Finish setting up"
            detail={`${setup.done}/${setup.total}`}
            onSelect={() => void resume(setup.resumeStep)}
          />
        ) : null}
        <ActionSheetSeparator />
        {panelOffered ? (
          <ActionSheetItem
            icon={MessageSquarePlus}
            label={panel.open ? "Close session about this page" : "Session about this page"}
            onSelect={panel.toggle}
          />
        ) : null}
        {waiting ? (
          <ActionSheetItem
            icon={Lightbulb}
            label="Improvements"
            detail={waitingCount > 0 ? `${waitingCount} waiting` : undefined}
            onSelect={() => setImprovementsOpen(true)}
          />
        ) : null}
        <ActionSheetSwitch
          icon={Moon}
          label="Dark mode"
          checked={theme === "dark"}
          onCheckedChange={() => toggleTheme()}
        />
        <ActionSheetItem
          icon={Github}
          label="View on GitHub"
          onSelect={() => window.open(GITHUB_URL, "_blank", "noopener,noreferrer")}
        />
      </ActionSheet>
      {waiting ? (
        <ImprovementsSheet open={improvementsOpen} onOpenChange={setImprovementsOpen} />
      ) : null}
      {status ? (
        <ActionSheet open={healthOpen} onOpenChange={setHealthOpen} title="Swarm health">
          <div className="space-y-3 px-3 pb-3">
            <HealthPopoverBody status={status} onNavigate={() => setHealthOpen(false)} />
          </div>
        </ActionSheet>
      ) : null}
    </>
  );
}

function HealthRowContent({
  dot,
  label,
  devMode,
}: {
  dot: string;
  label: string;
  devMode: boolean;
}) {
  return (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
        <span className={cn("size-2.5 rounded-full", dot)} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {devMode ? (
        <Badge variant="outline" size="tag" title="Dev mode: UI version checks are bypassed">
          Dev
        </Badge>
      ) : null}
    </>
  );
}
