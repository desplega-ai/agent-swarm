import { useMutation, useQueries, useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, Loader2, MousePointer2, RotateCw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import type { User } from "@/api/types";
import { ProviderIcon } from "@/components/shared/provider-icon";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CURRENT_USER_CARD_KEY } from "@/contexts/current-user-context";
import { deriveStorageKey } from "@/hooks/use-dismissible-card-key";
import { type Connection, getConnections } from "@/lib/config";
import { cn } from "@/lib/utils";
import {
  ConnectApiError,
  createConnectorCode,
  fetchDiscovery,
  fetchHealth,
  fetchUsers,
  fetchWhoami,
} from "./connect-api";
import {
  buildConnectorRedirect,
  CONNECT_CLIENT_NAMES,
  type ConnectClient,
  connectionsForCustomReturnTo,
  defaultConnectorLabel,
  lastUserStorageKey,
  parseClient,
  pickPreferredUser,
  resolveUserStep,
  selectConnectionStep,
  validateReturnTo,
} from "./connect-flow";

const ALLOW_LOCALHOST = import.meta.env.DEV;

function hostOf(apiUrl: string): string {
  try {
    return new URL(apiUrl).host;
  } catch {
    return apiUrl;
  }
}

function readStoredValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLastUser(connectionId: string, userId: string): void {
  try {
    localStorage.setItem(lastUserStorageKey(connectionId), userId);
  } catch {
    // Storage unavailable: the choice is just not remembered.
  }
}

function ClientMark({ client, className }: { client: ConnectClient; className?: string }) {
  if (client === "cursor") return <MousePointer2 aria-hidden className={cn("size-5", className)} />;
  return (
    <ProviderIcon
      provider={client === "claude" ? "anthropic" : "openai"}
      className={cn("size-5 opacity-100", className)}
    />
  );
}

/** Centered card shell outside the app chrome, like `/setup`. */
function ConnectShell({
  client,
  title,
  description,
  children,
}: {
  client: ConnectClient;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg border bg-muted">
            <ClientMark client={client} />
          </div>
          <CardTitle className="text-balance">{title}</CardTitle>
          {description ? (
            <CardDescription className="text-pretty">{description}</CardDescription>
          ) : null}
        </CardHeader>
        {children ? <CardContent className="flex flex-col gap-4">{children}</CardContent> : null}
      </Card>
    </main>
  );
}

/**
 * `/connect`: inbound handoff from the agent-swarm.dev connector. Opened as a
 * fresh tab with `return_to` (the connector's page) and `client`. It picks a
 * connection and a user, mints a single-use code, and navigates this same tab
 * back to `return_to` with `swarm`, `code` and `client`. It never touches
 * `window.opener` and never shows the code.
 */
export default function ConnectPage() {
  const [params] = useSearchParams();
  const client = parseClient(params.get("client"));
  const rawReturnTo = params.get("return_to");
  const connections = useMemo(() => getConnections(), []);

  const staticReturnTo = validateReturnTo(rawReturnTo, { allowLocalhost: ALLOW_LOCALHOST });
  // Not a built-in connector origin: it may still be a swarm's own
  // CONNECTOR_CONNECT_URL, which each server reports through discovery. Such a
  // destination is bound to the swarms that report it: only they are offered.
  const needsDiscovery = !staticReturnTo && !!rawReturnTo;
  const discoveries = useQueries({
    queries: connections.map((connection) => ({
      queryKey: ["connect-discovery", connection.apiUrl],
      queryFn: () => fetchDiscovery(connection),
      enabled: needsDiscovery,
      retry: false,
      staleTime: 60_000,
    })),
  });
  const boundConnections = needsDiscovery
    ? connectionsForCustomReturnTo(
        rawReturnTo,
        connections.map((connection, i) => ({
          connection,
          connectUrl: discoveries[i]?.data?.connectUrl,
        })),
      )
    : connections;
  const returnTo =
    staticReturnTo ?? (boundConnections.length > 0 ? new URL(rawReturnTo as string) : null);

  if (!returnTo) {
    if (needsDiscovery && discoveries.some((query) => query.isPending)) {
      return <ConnectShell client={client} title="Checking this connect link…" />;
    }
    return (
      <ConnectShell
        client={client}
        title="This connect link is not from agent-swarm.dev"
        description="Start again from the connector page. This tab will not send you anywhere."
      />
    );
  }

  return (
    <ConnectFlow
      client={client}
      returnTo={returnTo}
      connections={boundConnections}
      label={params.get("label")}
      connectionHint={params.get("connection")}
      userHint={params.get("user")}
    />
  );
}

function ConnectFlow({
  client,
  returnTo,
  connections,
  label,
  connectionHint,
  userHint,
}: {
  client: ConnectClient;
  returnTo: URL;
  connections: Connection[];
  label: string | null;
  connectionHint: string | null;
  userHint: string | null;
}) {
  const location = useLocation();
  const [pickedId, setPickedId] = useState<string | null>(connectionHint);
  const step = selectConnectionStep(connections, pickedId);
  const clientName = CONNECT_CLIENT_NAMES[client];

  if (step.kind === "none") {
    return (
      <ConnectShell
        client={client}
        title="Add a connection first"
        description={`Connect this dashboard to your swarm, then come back here to link ${clientName}.`}
      >
        <Button asChild>
          {/* `/setup` returns to `state.from` once the connection is saved. */}
          <Link to="/setup" state={{ from: `${location.pathname}${location.search}` }}>
            Add a connection
            <ArrowRight className="size-4" />
          </Link>
        </Button>
      </ConnectShell>
    );
  }

  if (step.kind === "pick") {
    return (
      <ConnectShell
        client={client}
        title="Choose a swarm"
        description={`Which swarm should ${clientName} use?`}
      >
        <ul className="flex flex-col gap-2">
          {step.connections.map((connection) => (
            <li key={connection.id}>
              <ConnectionRow connection={connection} onSelect={() => setPickedId(connection.id)} />
            </li>
          ))}
        </ul>
      </ConnectShell>
    );
  }

  return (
    <UserStep
      key={step.connection.id}
      client={client}
      connection={step.connection}
      returnTo={returnTo}
      label={label}
      userHint={userHint}
      onBack={connections.length > 1 ? () => setPickedId(null) : undefined}
    />
  );
}

function ConnectionRow({ connection, onSelect }: { connection: Connection; onSelect: () => void }) {
  const health = useQuery({
    queryKey: ["connect-health", connection.apiUrl],
    queryFn: () => fetchHealth(connection),
    retry: false,
    staleTime: 30_000,
  });
  const dot = health.isPending
    ? "bg-status-neutral"
    : health.isError
      ? "bg-status-error"
      : "bg-status-success";
  return (
    <button
      type="button"
      onClick={onSelect}
      className="hover-linger flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors hover:bg-accent"
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", dot)} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{connection.name}</span>
        <span className="truncate text-xs text-muted-foreground">{hostOf(connection.apiUrl)}</span>
      </span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {health.data ? `v${health.data.version}` : health.isError ? "Unreachable" : ""}
      </span>
    </button>
  );
}

function UserStep({
  client,
  connection,
  returnTo,
  label,
  userHint,
  onBack,
}: {
  client: ConnectClient;
  connection: Connection;
  returnTo: URL;
  label: string | null;
  userHint: string | null;
  onBack?: () => void;
}) {
  const clientName = CONNECT_CLIENT_NAMES[client];
  const host = hostOf(connection.apiUrl);
  const whoami = useQuery({
    queryKey: ["connect-whoami", connection.apiUrl, connection.apiKey.slice(-4)],
    queryFn: () => fetchWhoami(connection),
    retry: false,
  });
  const userStep = whoami.isSuccess ? resolveUserStep(whoami.data) : null;
  const users = useQuery({
    queryKey: ["connect-users", connection.apiUrl, connection.apiKey.slice(-4)],
    queryFn: () => fetchUsers(connection),
    enabled: userStep?.kind === "pick",
    retry: false,
  });
  const [chosen, setChosen] = useState<User | null>(null);
  // A known user skips the picker and the card shows the confirm step: the
  // token-bound user, else the `user` hint (People page), then the dashboard's
  // own "who are you" choice for this connection, then the last pick on this
  // page. "Pick someone else" swaps the card back to the picker.
  const [autoDismissed, setAutoDismissed] = useState(false);

  const hinted = autoDismissed
    ? null
    : pickPreferredUser(users.data ?? [], [
        userHint,
        readStoredValue(deriveStorageKey(connection.apiUrl, CURRENT_USER_CARD_KEY)),
        readStoredValue(lastUserStorageKey(connection.id)),
      ]);
  const selfUser = userStep?.kind === "self" ? userStep.user : null;
  const confirmUser = selfUser ?? chosen ?? hinted;

  if (whoami.isPending || (userStep?.kind === "pick" && users.isPending)) {
    return <ConnectShell client={client} title={`Connecting to ${host}…`} />;
  }

  const loadError = whoami.error ?? users.error;
  if (loadError) {
    return (
      <ConnectShell client={client} title={`Could not load ${host}`}>
        <AlertCallout tone="error" icon={AlertCircle}>
          {loadError.message}
        </AlertCallout>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => {
              void whoami.refetch();
              if (userStep?.kind === "pick") void users.refetch();
            }}
          >
            <RotateCw className="size-4" />
            Retry
          </Button>
          {onBack ? (
            <Button variant="ghost" onClick={onBack}>
              Choose another swarm
            </Button>
          ) : null}
        </div>
      </ConnectShell>
    );
  }

  if (confirmUser) {
    // A token-bound user, or the only user: there is no one else to pick.
    const canPickAnother = !selfUser && (users.data?.length ?? 0) > 1;
    return (
      <ConfirmStep
        client={client}
        connection={connection}
        user={confirmUser}
        returnTo={returnTo}
        initialLabel={label || defaultConnectorLabel(client)}
        onPickAnother={
          canPickAnother
            ? () => {
                setChosen(null);
                setAutoDismissed(true);
              }
            : undefined
        }
        onBack={onBack}
      />
    );
  }

  const lastUserId = readStoredValue(lastUserStorageKey(connection.id));
  const sorted = [...(users.data ?? [])].sort((a, b) =>
    a.id === lastUserId ? -1 : b.id === lastUserId ? 1 : a.name.localeCompare(b.name),
  );

  return (
    <ConnectShell
      client={client}
      title="Who are you?"
      description={`${clientName} will send and read tasks on ${host} as this person.`}
    >
      <Command className="rounded-md border">
        <CommandInput placeholder="Search people…" />
        <CommandList className="max-h-72">
          <CommandEmpty>No one matches.</CommandEmpty>
          {sorted.map((user) => (
            <CommandItem
              key={user.id}
              value={`${user.name} ${user.email ?? ""} ${user.id}`}
              onSelect={() => {
                writeLastUser(connection.id, user.id);
                setChosen(user);
              }}
              className="flex items-center gap-2"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{user.name}</span>
                {user.email ? (
                  <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                ) : null}
              </span>
              {user.id === lastUserId ? (
                <Badge variant="outline" size="tag">
                  Last used
                </Badge>
              ) : null}
              {user.role ? (
                <Badge variant="secondary" size="tag">
                  {user.role}
                </Badge>
              ) : null}
            </CommandItem>
          ))}
        </CommandList>
      </Command>
      {onBack ? (
        <Button variant="ghost" className="self-start" onClick={onBack}>
          Choose another swarm
        </Button>
      ) : null}
    </ConnectShell>
  );
}

function ConfirmStep({
  client,
  connection,
  user,
  returnTo,
  initialLabel,
  onPickAnother,
  onBack,
}: {
  client: ConnectClient;
  connection: Connection;
  user: User;
  returnTo: URL;
  initialLabel: string;
  onPickAnother?: () => void;
  onBack?: () => void;
}) {
  const clientName = CONNECT_CLIENT_NAMES[client];
  const host = hostOf(connection.apiUrl);
  const [label, setLabel] = useState(initialLabel);
  const [redirecting, setRedirecting] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  // Focus the primary action, not the label: most people keep the default
  // label, so Enter mints straight away.
  useEffect(() => {
    submitRef.current?.focus();
  }, []);
  const create = useMutation({
    mutationFn: async () => {
      const { connectUrl } = await createConnectorCode(
        connection,
        user.id,
        label.trim() || initialLabel,
      );
      // Re-check at the last moment. Only this swarm's own connect URL may
      // extend the allowlist, so the code goes nowhere another swarm chose.
      const target = validateReturnTo(returnTo.toString(), {
        extraOrigins: [connectUrl],
        allowLocalhost: ALLOW_LOCALHOST,
      });
      if (!target) throw new Error("This connect link is not from agent-swarm.dev.");
      return buildConnectorRedirect(target, connectUrl, client);
    },
    onSuccess: (redirectUrl) => {
      setRedirecting(true);
      window.location.assign(redirectUrl);
    },
  });
  const busy = create.isPending || redirecting;
  const error = create.error;
  const apiError = error instanceof ConnectApiError ? error : null;

  return (
    <ConnectShell
      client={client}
      title={`Connect ${clientName} as ${user.name}?`}
      description={
        <>
          The token can do what {user.name} can do on{" "}
          <span className="font-medium text-foreground">{host}</span>
          {user.role ? ` (${user.role})` : ""}, nothing more. You then go back to{" "}
          <span className="font-medium text-foreground">{returnTo.host}</span>.
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) create.mutate();
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="connect-label">Label</Label>
          <Input
            id="connect-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
          />
        </div>
        {error ? (
          <AlertCallout tone="error" icon={AlertCircle}>
            <p>{error.message}</p>
            {apiError?.status === 400 ? (
              <Link to="/settings/connections" className="underline underline-offset-2">
                Open connection settings
              </Link>
            ) : null}
          </AlertCallout>
        ) : null}
        {redirecting ? (
          <p className="text-sm text-muted-foreground">Taking you back to agent-swarm.dev…</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button ref={submitRef} type="submit" disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {apiError?.status === null ? "Retry" : "Create and continue"}
          </Button>
          {onBack ? (
            <Button type="button" variant="ghost" onClick={onBack} disabled={busy}>
              Choose another swarm
            </Button>
          ) : null}
        </div>
      </form>
      {onPickAnother ? (
        <p className="text-sm text-muted-foreground">
          Not you?{" "}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={onPickAnother}
            disabled={busy}
          >
            Pick someone else
          </Button>
        </p>
      ) : null}
    </ConnectShell>
  );
}
