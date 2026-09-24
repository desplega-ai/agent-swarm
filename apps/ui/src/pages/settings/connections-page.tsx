import { LockKeyhole, UserRound } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { ConnectionsSection } from "@/pages/config/components/connections-section";

/**
 * Connections settings page: server connections (API URL + key). Before any
 * connection exists, `RootLayout` sends the operator to `/setup` step 1.
 */
export default function ConnectionsPage() {
  const { connectionLocked } = useConfig();
  const { locked, user } = useCurrentUser();

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader title="Connections" />
      {connectionLocked ? (
        <Alert>
          <LockKeyhole className="h-4 w-4" />
          <AlertDescription>
            Connection details are set by this UI deployment. They cannot be changed here.
          </AlertDescription>
        </Alert>
      ) : null}
      {locked && user ? (
        <Alert>
          <UserRound className="h-4 w-4" />
          <AlertDescription>
            {/* Single <p>: AlertDescription is a grid, so bare inline children
                each land on their own row. */}
            <p>
              You are acting as <strong>{user.name}</strong>. This connection fixes that identity,
              so it cannot be switched.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      <ConnectionsSection readOnly={connectionLocked} />
    </div>
  );
}
