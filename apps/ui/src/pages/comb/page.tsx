import { FolderOpen, FolderTree, HardDrive, Unplug } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { CombBreadcrumbs } from "@/components/comb/breadcrumbs";
import { ConnectCard } from "@/components/comb/connect-card";
import { OpenInAgentFsButton } from "@/components/comb/file-actions";
import { FileView } from "@/components/comb/file-view";
import { FolderView } from "@/components/comb/folder-view";
import { LiveIndicator } from "@/components/comb/live-indicator";
import { TreeRail } from "@/components/comb/tree-rail";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { useIsMobile } from "@/hooks/use-mobile";
import { fileRedirectPath } from "@/lib/agent-fs/state";
import { parseCombSplat } from "@/lib/comb/paths";

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
              <Button size="sm" variant="outline" onClick={agentFs.retry}>
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
        <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8">
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
  return <OpenInAgentFsButton target={parseCombSplat({ orgId, driveId, splat })} />;
}

function ConnectedView() {
  const { me, disconnect } = useAgentFs();
  const { orgId, driveId, "*": splat } = useParams();
  const isMobile = useIsMobile();
  const [treeOpen, setTreeOpen] = useState(false);
  const location = useMemo(
    () => (orgId && driveId ? parseCombSplat({ orgId, driveId, splat }) : null),
    [orgId, driveId, splat],
  );
  const connectedAs = `Connected as ${me?.displayName || me?.email}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <PageHeader
        title={
          location ? (
            <>
              {isMobile ? (
                <Sheet open={treeOpen} onOpenChange={setTreeOpen}>
                  <SheetTrigger asChild>
                    <Button variant="outline" size="icon" aria-label="Browse files">
                      <FolderTree />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" className="w-72 gap-0 p-0" aria-describedby={undefined}>
                    <SheetHeader className="border-b border-border">
                      <SheetTitle>Files</SheetTitle>
                    </SheetHeader>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      <TreeRail
                        key={`${location.orgId}/${location.driveId}`}
                        location={location}
                        onNavigate={() => setTreeOpen(false)}
                      />
                    </div>
                  </SheetContent>
                </Sheet>
              ) : null}
              <CombBreadcrumbs location={location} />
            </>
          ) : (
            "Comb"
          )
        }
        action={
          <div className="flex items-center gap-2">
            {/* step-11: live updates indicator. */}
            {location ? <LiveIndicator /> : null}
            <Badge variant="outline" className="hidden max-w-sm sm:inline-flex" title={connectedAs}>
              <span className="truncate">{connectedAs}</span>
            </Badge>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive-outline" size="sm">
                  Disconnect
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Disconnect agent-fs?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes your agent-fs key from this browser. Your agent-fs account and
                    files stay.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep connected</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={disconnect}>
                    Disconnect
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        }
      />
      {location ? (
        <div className="flex min-h-0 flex-1 gap-4">
          {isMobile ? null : (
            <aside
              aria-label="Drive tree"
              className="w-64 shrink-0 overflow-y-auto rounded-xl border border-border bg-card"
            >
              <TreeRail key={`${location.orgId}/${location.driveId}`} location={location} />
            </aside>
          )}
          <section aria-label="Drive content" className="flex min-h-0 min-w-0 flex-1 flex-col">
            {location.isFolder ? (
              <FolderView folder={location} />
            ) : (
              <FileView
                key={`${location.orgId}/${location.driveId}:${location.path}`}
                file={location}
              />
            )}
          </section>
        </div>
      ) : (
        <EmptyState
          icon={HardDrive}
          title="No swarm drive yet"
          description="The swarm has not set up its agent-fs drive. Check AGENT_FS_DEFAULT_ORG_ID and AGENT_FS_DEFAULT_DRIVE_ID in Settings, Configuration."
          fullPage
        />
      )}
    </div>
  );
}
