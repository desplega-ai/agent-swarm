import { AlertCircle, Loader2, RotateCw, UserPlus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfig } from "@/hooks/use-config";
import { connectionsManagedByDeployment } from "@/lib/config";
import { exchangeInviteCode, fetchCombEnabled } from "./join-api";
import {
  JOIN_COPY,
  type JoinOutcome,
  type JoinParams,
  parseJoinParams,
  runJoin,
  swarmHost,
  withoutJoinParams,
} from "./join-flow";

/** Centered card shell outside the app chrome, like `/connect`. */
function JoinShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg border bg-muted">
            <UserPlus aria-hidden className="size-5" />
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
 * `/join?swarm=#code=`: the teammate's side of an invite. Shows the swarm host
 * and waits for a click on Join: anyone can send a link with any `swarm`, so
 * the dashboard never saves or switches to it without that click. Then it
 * trades the one-time code for a personal token, saves it as a dashboard
 * connection, and lands on Home (or Comb, when Comb is on). The code leaves
 * the URL and the history entry before anything else happens.
 */
export default function JoinPage() {
  const navigate = useNavigate();
  const { addConnection, switchConnection } = useConfig();
  // Read once: the effect below drops the params from the URL.
  const [params] = useState<JoinParams | null>(() =>
    parseJoinParams(window.location.search, window.location.hash),
  );
  const [outcome, setOutcome] = useState<JoinOutcome | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const join = useCallback(
    async (joinParams: JoinParams) => {
      setOutcome(null);
      const result = await runJoin(
        {
          connectionsManaged: connectionsManagedByDeployment,
          exchange: exchangeInviteCode,
          addConnection,
          switchConnection,
          combEnabled: fetchCombEnabled,
        },
        joinParams,
      );
      if (result.kind === "joined") {
        void navigate(result.redirect, { replace: true });
        return;
      }
      setOutcome(result);
    },
    [addConnection, switchConnection, navigate],
  );

  useEffect(() => {
    // Drop the code from the address bar and the history entry at once.
    const url = new URL(window.location.href);
    const rest = withoutJoinParams(url.search);
    if (rest !== url.search || url.hash) {
      url.search = rest;
      url.hash = "";
      window.history.replaceState(window.history.state, "", url.toString());
    }
  }, []);

  if (!params) {
    return (
      <JoinShell title="Invite link incomplete" description={JOIN_COPY.missing}>
        <GoHome />
      </JoinShell>
    );
  }

  const host = swarmHost(params.swarm);

  if (!confirmed) {
    return (
      <JoinShell
        title={`Join ${host}?`}
        description="You have an invite to the agent swarm at this address. Join only if you expect this invite."
      >
        <p className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm break-all">
          {params.swarm}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              setConfirmed(true);
              void join(params);
            }}
          >
            Join swarm
          </Button>
          <GoHome label="Not now" />
        </div>
      </JoinShell>
    );
  }

  if (!outcome) {
    return (
      <JoinShell title={`Joining ${host}…`}>
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Setting up your access.
        </p>
      </JoinShell>
    );
  }

  if (outcome.kind === "invalid") {
    return (
      <JoinShell title="Invite link expired" description={JOIN_COPY.invalid}>
        <GoHome />
      </JoinShell>
    );
  }

  if (outcome.kind === "managed") {
    return (
      <JoinShell title="Open the invite elsewhere" description={JOIN_COPY.managed}>
        <GoHome />
      </JoinShell>
    );
  }

  if (outcome.kind === "joined") return null;

  return (
    <JoinShell title={`Could not join ${host}`}>
      <AlertCallout tone="error" icon={AlertCircle}>
        {outcome.message}
      </AlertCallout>
      {outcome.retryable ? (
        <Button variant="outline" className="self-start" onClick={() => void join(params)}>
          <RotateCw className="size-4" />
          Retry
        </Button>
      ) : null}
    </JoinShell>
  );
}

function GoHome({ label = "Go to dashboard" }: { label?: string }) {
  return (
    <Button asChild variant="outline" className="self-start">
      <Link to="/">{label}</Link>
    </Button>
  );
}
