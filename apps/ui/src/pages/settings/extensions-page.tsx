import { Blocks, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useExtensions } from "@/api/hooks/use-extensions";
import type { ExtensionStatus } from "@/api/types";
import { EmptyState } from "@/components/shared/empty-state";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatSmartTime } from "@/lib/utils";

/** Status to badge variant. `error` and `auto-disabled` both need attention. */
export function statusBadgeVariant(
  status: ExtensionStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "enabled") return "default";
  if (status === "error" || status === "auto-disabled") return "destructive";
  return "outline";
}

/**
 * Installed extensions — the operator view of `GET /api/extensions`. Each row
 * links to the detail page, where the bundle is edited, enabled, versioned,
 * and its run log read.
 */
export default function ExtensionsPage() {
  const navigate = useNavigate();
  const { data: extensions, isLoading, error } = useExtensions();

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader
        title="Extensions"
        description="Bundles that hook into swarm orchestration — task creation, follow-up, Slack routing, heartbeat remediation, and tool calls."
        action={
          <Button type="button" size="sm" onClick={() => navigate("/settings/extensions/new")}>
            <Plus className="h-4 w-4" />
            New extension
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            Failed to load extensions: {error instanceof Error ? error.message : String(error)}
          </AlertDescription>
        </Alert>
      )}

      {!error && (extensions?.length ?? 0) === 0 ? (
        <EmptyState
          icon={Blocks}
          title="No extensions installed"
          description="Install a bundle to change routing, follow-up, heartbeat, or tool-call behaviour without a core change."
          action={
            <Button type="button" size="sm" onClick={() => navigate("/settings/extensions/new")}>
              <Plus className="h-4 w-4" />
              New extension
            </Button>
          }
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Version</TableHead>
                <TableHead className="text-right">Priority</TableHead>
                <TableHead className="text-right">Failures</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(extensions ?? []).map((extension) => (
                <TableRow
                  key={extension.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/settings/extensions/${extension.id}`)}
                >
                  <TableCell>
                    <div className="font-medium">{extension.name}</div>
                    <div className="text-xs text-muted-foreground truncate max-w-md">
                      {extension.description || "—"}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(extension.status)} size="tag">
                      {extension.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    v{extension.activeVersion}
                    {extension.version !== extension.activeVersion && (
                      <span className="text-muted-foreground"> (latest v{extension.version})</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {extension.priority}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {extension.consecutiveFailures}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatSmartTime(extension.updatedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
