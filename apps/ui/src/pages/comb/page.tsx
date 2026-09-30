import { FolderOpen, Unplug } from "lucide-react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useAgentFsLs } from "@/api/hooks/use-agent-fs";
import { ConnectCard } from "@/components/comb/connect-card";
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
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { useAgentFs } from "@/contexts/agent-fs-context";

/** Comb: the swarm's agent-fs drive, read with the human's own agent-fs key. */
export default function CombPage() {
  const agentFs = useAgentFs();
  const { orgId: routeOrgId } = useParams();

  // `/file` opens the swarm drive once `/status` names it.
  if (!routeOrgId && agentFs.endpoint && agentFs.orgId && agentFs.driveId) {
    return <Navigate to={`/file/~/${agentFs.orgId}/${agentFs.driveId}/`} replace />;
  }

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
            <Button asChild size="sm">
              <Link to="/settings/configuration?search=COMB_ENABLED">Open Configuration</Link>
            </Button>
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
            <Button size="sm" variant="outline" onClick={agentFs.retry}>
              Retry
            </Button>
          }
          fullPage
        />
      );
    case "needs-connect":
    case "invalid-key":
      return (
        <div className="flex flex-1 items-center justify-center py-8">
          <ConnectCard />
        </div>
      );
    case "ready":
      return <ConnectedView />;
  }
}

function ConnectedView() {
  const { me, disconnect } = useAgentFs();
  const root = useAgentFsLs("/");
  const count = root.data?.entries.length;
  // Step-5 replaces this placeholder body with the tree and folder views.
  const summary = root.error
    ? root.error.message
    : count === undefined
      ? "Loading the drive root…"
      : `${count} ${count === 1 ? "entry" : "entries"} at the drive root.`;
  const connectedAs = `Connected as ${me?.displayName || me?.email}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Comb"
        action={
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="max-w-40 sm:max-w-sm" title={connectedAs}>
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
      <Card>
        <CardHeader>
          <CardTitle>Swarm drive</CardTitle>
          <CardDescription>{summary}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
