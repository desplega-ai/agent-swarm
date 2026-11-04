import { AlertCircle, FolderOpen, Loader2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, FsApiError } from "@/api/client";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const ERRORS: Record<number, string> = {
  400: "This link does not point to your agent-fs app.",
  403: "Your role cannot open the shared files.",
  409: "Your agent-fs account is not ready yet. Try again in a minute.",
  429: "Too many attempts. Wait a minute, then try again.",
  501: "This agent-fs server is too old for this link. Ask an admin to upgrade it.",
  503: "This swarm has no agent-fs set up.",
};

function returnHost(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof FsApiError && ERRORS[error.status]) return ERRORS[error.status];
  return error instanceof Error ? error.message : String(error);
}

function ContinueCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-lg border bg-muted">
            <FolderOpen aria-hidden className="size-5" />
          </div>
          <CardTitle className="text-balance">{title}</CardTitle>
          <CardDescription className="text-pretty">
            Your swarm signs you in to agent-fs.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">{children}</CardContent>
      </Card>
    </div>
  );
}

/**
 * `/fs/continue?return_to=<live agent-fs URL>`: "Continue with your swarm" on
 * the live agent-fs app lands here. The dashboard holds the swarm session, so
 * it asks the API for a named agent-fs key and goes back to `return_to` with
 * the key in the fragment. The live app stores the key and strips it.
 */
export default function FsContinuePage() {
  const [returnTo] = useState(() => new URLSearchParams(window.location.search).get("return_to"));
  const host = returnHost(returnTo);
  const [error, setError] = useState<string | null>(null);
  // One key per visit: StrictMode runs the effect twice.
  const started = useRef(false);

  useEffect(() => {
    if (!returnTo || !host || started.current) return;
    started.current = true;
    api
      .fsContinue({ returnTo })
      .then(({ redirectUrl }) => window.location.replace(redirectUrl))
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [returnTo, host]);

  if (!returnTo || !host) {
    return (
      <ContinueCard title="Link incomplete">
        <AlertCallout tone="error" icon={AlertCircle}>
          {ERRORS[400]}
        </AlertCallout>
        <OpenFiles />
      </ContinueCard>
    );
  }

  if (error) {
    return (
      <ContinueCard title={`Could not continue to ${host}`}>
        <AlertCallout tone="error" icon={AlertCircle}>
          {error}
        </AlertCallout>
        <OpenFiles />
      </ContinueCard>
    );
  }

  return (
    <ContinueCard title={`Continuing to ${host}…`}>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Opening your file.
      </p>
    </ContinueCard>
  );
}

function OpenFiles() {
  return (
    <Button asChild variant="outline" className="self-start">
      <Link to="/file">Open files here</Link>
    </Button>
  );
}
