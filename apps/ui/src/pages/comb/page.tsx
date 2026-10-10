import { FolderOpen, HardDrive, Unplug } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { CombAccountMenu } from "@/components/comb/account-menu";
import { CombBreadcrumbs } from "@/components/comb/breadcrumbs";
import { CombLayoutProvider, useCombLayout } from "@/components/comb/comb-layout";
import { ConnectCard } from "@/components/comb/connect-card";
import { OpenInAgentFsButton } from "@/components/comb/file-actions";
import { FileActions, FileSubtitle, FileTitle } from "@/components/comb/file-header";
import { FileView } from "@/components/comb/file-view";
import { FolderView } from "@/components/comb/folder-view";
import { CombPresenceProvider } from "@/components/comb/presence-context";
import { LeftPanel, LeftPanelSheet } from "@/components/comb/side-panels";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Button } from "@/components/ui/button";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { useConfig } from "@/hooks/use-config";
import { useMediaQuery } from "@/hooks/use-media-query";
import { fileRedirectPath } from "@/lib/agent-fs/state";
import { type CombLocation, parseCombSplat } from "@/lib/comb/paths";

/** Comb: the swarm's agent-fs drive, read with the human's own agent-fs key. */
export default function CombPage() {
  const agentFs = useAgentFs();
  const { orgId: routeOrgId } = useParams();

  const redirect = fileRedirectPath(routeOrgId, agentFs);
  if (redirect) return <Navigate to={redirect} replace />;

  switch (agentFs.state) {
    case "loading":
      return <PageSkeleton />;
    case "disabled":
      return (
        <EmptyState
          icon={FolderOpen}
          title="Comb is off"
          description="Comb shows the swarm's agent-fs drive here. Turn on COMB_ENABLED in Settings, Configuration. Comb needs agent-fs."
          action={
            <>
              <Button asChild size="sm">
                <Link to="/settings/configuration?search=COMB_ENABLED">Open Configuration</Link>
              </Button>
              <RouteOpenInAgentFs />
            </>
          }
          fullPage
        />
      );
    case "unreachable":
      return (
        <EmptyState
          icon={Unplug}
          title="Cannot reach agent-fs"
          description={
            agentFs.error && agentFs.error.status !== 0
              ? agentFs.error.message
              : `No answer from ${agentFs.endpoint}. Check AGENT_FS_PUBLIC_URL in Settings, Configuration.`
          }
          action={
            <>
              <Button size="sm" onClick={agentFs.retry}>
                Retry
              </Button>
              <RouteOpenInAgentFs />
            </>
          }
          fullPage
        />
      );
    case "needs-connect":
    case "invalid-key":
      return (
        <div className="flex flex-1 flex-col items-center justify-start gap-3 pt-16 pb-8">
          <ConnectCard />
          <RouteOpenInAgentFs />
        </div>
      );
    case "ready":
      return <ConnectedView />;
  }
}

/**
 * step-13: Slack and prompt links point at Comb. Without a key, with Comb off
 * (a rollback), or with agent-fs unreachable, the file or folder in the route
 * still opens in the agent-fs live UI.
 */
function RouteOpenInAgentFs() {
  const { orgId, driveId, "*": splat } = useParams();
  if (!orgId || !driveId) return null;
  return <OpenInAgentFsButton target={parseCombSplat({ orgId, driveId, splat })} labeled />;
}

function ConnectedView() {
  const { orgId, driveId, "*": splat } = useParams();
  const { apiUrl } = useConfig().config;
  const location = useMemo(
    () => (orgId && driveId ? parseCombSplat({ orgId, driveId, splat }) : null),
    [orgId, driveId, splat],
  );

  if (!location) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <CombHeader title={null} />
        <EmptyState
          icon={HardDrive}
          title="No swarm drive yet"
          description="The swarm has not set up its agent-fs drive. Check AGENT_FS_DEFAULT_ORG_ID and AGENT_FS_DEFAULT_DRIVE_ID in Settings, Configuration."
          fullPage
        />
      </div>
    );
  }
  return (
    // Panel state is per swarm: a new API URL starts from its own stored state.
    <CombLayoutProvider key={apiUrl} location={location}>
      {/* One presence connection per drive (other people's avatars and cursors). */}
      <CombPresenceProvider
        key={`${location.orgId}/${location.driveId}`}
        orgId={location.orgId}
        driveId={location.driveId}
      >
        <CombWorkspace location={location} />
      </CombPresenceProvider>
    </CombLayoutProvider>
  );
}

/**
 * One header row (the title, the file actions, the account), then the left
 * panel (Files and Outline), the content, and for a file the comment panel.
 */
function CombWorkspace({ location }: { location: CombLocation }) {
  const layout = useCombLayout();
  const inline = layout?.inline ?? true;
  const file = location.isFolder ? null : location;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <CombHeader
        lead={inline ? null : <LeftPanelSheet location={location} />}
        title={file ? <FileTitle file={file} /> : <CombBreadcrumbs location={location} />}
        subtitle={file ? <FileSubtitle file={file} /> : null}
        actions={file ? <FileActions file={file} /> : null}
      />
      <div className="flex min-h-0 flex-1 gap-3">
        {inline ? <LeftPanel location={location} /> : null}
        <section aria-label="Drive content" className="flex min-h-0 min-w-0 flex-1 flex-col">
          {file ? (
            <FileView key={`${file.orgId}/${file.driveId}:${file.path}`} file={file} />
          ) : (
            <FolderView folder={location} />
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * The Comb header: the title with its subtitle, the actions, and the account.
 * One height for files and folders, so the panels below never move. On phones
 * the actions move to the subtitle row, so the name keeps the width.
 */
function CombHeader({
  lead,
  title,
  subtitle,
  actions,
}: {
  lead?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  const wide = useMediaQuery("(min-width: 640px)");
  const actionGroup = actions ? (
    <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
  ) : null;
  return (
    <div className="flex min-h-11 shrink-0 items-center gap-2">
      {lead}
      <div className="flex min-w-0 flex-1 flex-col">
        {title}
        {subtitle || (!wide && actionGroup) ? (
          <div className="flex min-w-0 items-center justify-between gap-2">
            {subtitle}
            {wide ? null : actionGroup}
          </div>
        ) : null}
      </div>
      {wide ? actionGroup : null}
      <div className={wide && actionGroup ? "ml-2" : undefined}>
        <CombAccountMenu />
      </div>
    </div>
  );
}
