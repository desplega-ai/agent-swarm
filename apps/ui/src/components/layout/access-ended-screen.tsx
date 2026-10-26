import { ArrowRightLeft, KeyRound, RotateCw, Trash2, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useConfig } from "@/hooks/use-config";
import {
  type Connection,
  connectionName,
  EMBED_CONNECTION_ID,
  isUserTokenApiKey,
} from "@/lib/config";

/** The saved name, else the host. An embed connection is named `embed:<host>`. */
function swarmLabel(connection: Connection | null, apiUrl: string): string {
  const name = connection?.name?.trim();
  return name && !name.startsWith("embed:") ? name : connectionName(apiUrl);
}

/** What the screen says, by the kind of key the browser holds. */
export function accessEndedCopy(
  apiKey: string,
  swarm: string,
  locked: boolean,
): { title: string; description: string } {
  if (isUserTokenApiKey(apiKey)) {
    return {
      title: `Your access to ${swarm} ended`,
      description:
        "An admin suspended your user or revoked your token. Ask an admin of this swarm for a new invite link.",
    };
  }
  return {
    title: `${swarm} does not accept the saved key`,
    description: locked
      ? "The API key changed, or someone installed the swarm again. Ask the admin of this dashboard to set the new key."
      : "The API key changed, or someone installed the swarm again. Connect again with the new key.",
  };
}

/**
 * Shown by the app shell instead of the dashboard when the API rejects the
 * saved key (`useAccessCheck`): no cached data, no polling. Try again checks
 * the key again. Remove forgets this connection in this browser: the
 * dashboard then opens the next saved connection, or `/setup` to connect.
 */
export function AccessEndedScreen({
  checking,
  onRetry,
}: {
  checking: boolean;
  onRetry: () => void;
}) {
  const {
    activeConnection,
    connections,
    config,
    connectionLocked,
    removeConnection,
    switchConnection,
  } = useConfig();
  const swarm = swarmLabel(activeConnection, config.apiUrl);
  const userToken = isUserTokenApiKey(config.apiKey);
  const copy = accessEndedCopy(config.apiKey, swarm, connectionLocked);
  const Icon = userToken ? UserX : KeyRound;
  // An embed connection wins over the saved list while it exists: remove it first.
  const others =
    activeConnection && activeConnection.id !== EMBED_CONNECTION_ID
      ? connections.filter((connection) => connection.id !== activeConnection.id)
      : [];

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg border bg-muted">
            <Icon aria-hidden className="size-5" />
          </div>
          <CardTitle className="text-balance">{copy.title}</CardTitle>
          <CardDescription className="text-pretty">{copy.description}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={onRetry} disabled={checking}>
              {checking ? <Spinner className="size-4" /> : <RotateCw aria-hidden />}
              Try again
            </Button>
            {!connectionLocked && activeConnection ? (
              <Button variant="outline" onClick={() => removeConnection(activeConnection.id)}>
                <Trash2 aria-hidden />
                Remove from this browser
              </Button>
            ) : null}
          </div>
          {others.length > 0 && !connectionLocked ? (
            <div className="flex flex-col gap-2 border-t pt-4">
              <p className="text-xs text-muted-foreground">Or open another swarm</p>
              <ul className="flex flex-col gap-1">
                {others.map((connection) => (
                  <li key={connection.id}>
                    <Button
                      variant="ghost"
                      className="w-full justify-start"
                      onClick={() => switchConnection(connection.id)}
                    >
                      <ArrowRightLeft aria-hidden />
                      <span className="truncate">{swarmLabel(connection, connection.apiUrl)}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
