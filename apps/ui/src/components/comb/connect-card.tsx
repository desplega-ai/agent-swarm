import { AlertCircle, Info, RotateCw } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { SecretInput } from "@/components/shared/secret-input";
import { StatusLine } from "@/components/shared/status-icon";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsRow } from "@/components/ui/settings-row";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { connectWithKey } from "./connect-flow";
import { useAutoConnect } from "./use-auto-connect";
import { useConnectFlowDeps } from "./use-connect-flow-deps";

/** The upgrade hint of the paste-key fallback. */
export const AGENT_FS_UPGRADE_HINT =
  "This agent-fs server cannot create keys for the dashboard. Upgrade agent-fs to 0.18.17 or later, or paste an agent-fs key.";

const KEY_NOTE = "Each browser gets its own named agent-fs key. Revoke it any time in agent-fs.";

/**
 * Comb with no working key in this browser. The browser gets its own named
 * agent-fs key through the swarm with no click (`useAutoConnect`). The card
 * shows the wait, a pending account, a failure with Retry, or (agent-fs too
 * old for named keys) the paste-key form.
 */
export function ConnectCard() {
  const { state, endpoint } = useAgentFs();
  const { outcome, running, retry } = useAutoConnect();
  if (!endpoint) return null;

  if (running || outcome === null) {
    return (
      <ConnectShell title="Connecting your files" description="This takes a few seconds.">
        <StatusLine tone="busy">Creating a key for this browser</StatusLine>
      </ConnectShell>
    );
  }
  switch (outcome.kind) {
    case "pending":
      return <PendingFilesCard reason={outcome.reason} onRetry={retry} />;
    case "unsupported":
      return <PasteKeyCard />;
    case "failed":
      return (
        <ConnectShell title="Could not connect your files" description={KEY_NOTE}>
          <AlertCallout tone="error" icon={AlertCircle}>
            {outcome.message}
          </AlertCallout>
          <RetryButton onRetry={retry} />
        </ConnectShell>
      );
    case "connected":
      // The key this page load minted is gone: forgotten, or rejected again.
      return (
        <ConnectShell title="Connect your files" description={KEY_NOTE}>
          {state === "invalid-key" ? (
            <AlertCallout tone="warning" icon={AlertCircle}>
              agent-fs no longer accepts this browser's key.
            </AlertCallout>
          ) : null}
          <Button className="w-full" onClick={retry}>
            Create a key for this browser
          </Button>
        </ConnectShell>
      );
  }
}

function ConnectShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onRetry}>
      <RotateCw />
      Retry
    </Button>
  );
}

/** The swarm could not make the agent-fs account ready. `reason` is the server's. */
export function PendingFilesCard({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <ConnectShell
      title="Your files account is not ready yet"
      description="The swarm could not finish your agent-fs account. Ask a swarm admin to check the agent-fs setup."
    >
      <AlertCallout tone="warning" icon={AlertCircle}>
        {reason}
      </AlertCallout>
      <RetryButton onRetry={onRetry} />
    </ConnectShell>
  );
}

/** The fallback for an agent-fs without named keys: paste an existing `af_` key. */
function PasteKeyCard() {
  const deps = useConnectFlowDeps();
  const { orgId, driveId } = useAgentFs();
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const driveReady = orgId !== null && driveId !== null;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const key = apiKey.trim();
    if (!key || !deps || !driveReady) return;
    setBusy(true);
    setError(null);
    const outcome = await connectWithKey(deps, key);
    setBusy(false);
    if (outcome.kind === "failed") setError(outcome.message);
  }

  return (
    <ConnectShell
      title="Connect agent-fs"
      description="Files reads the swarm drive with your own agent-fs identity."
    >
      {!driveReady && (
        <AlertCallout tone="warning" icon={AlertCircle}>
          The swarm drive is not set up yet. Ask a swarm admin to check the agent-fs setup.
        </AlertCallout>
      )}
      <PasteKeyForm
        notice={AGENT_FS_UPGRADE_HINT}
        apiKey={apiKey}
        onApiKeyChange={setApiKey}
        busy={busy}
        disabled={!driveReady}
        onSubmit={(event) => void onSubmit(event)}
      />
      {error && (
        <AlertCallout tone="error" icon={AlertCircle}>
          {error}
        </AlertCallout>
      )}
      <p className="text-xs text-muted-foreground">
        Your agent-fs key is stored in this browser only. Forget this browser's key removes it.
      </p>
    </ConnectShell>
  );
}

/** "Paste a key": the form of the paste-key fallback, also used by the `/setup` Files step. */
export function PasteKeyForm({
  notice,
  apiKey,
  onApiKeyChange,
  busy,
  disabled,
  onSubmit,
}: {
  notice: string | null;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  busy: boolean;
  disabled: boolean;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="space-y-4 pt-2" onSubmit={onSubmit}>
      {notice && (
        <AlertCallout tone="info" icon={Info}>
          {notice}
        </AlertCallout>
      )}
      <SettingsRow label="agent-fs key" htmlFor="comb-connect-key">
        <SecretInput
          id="comb-connect-key"
          value={apiKey}
          onChange={onApiKeyChange}
          placeholder="af_..."
          autoComplete="new-password"
          disabled={busy}
          required
        />
      </SettingsRow>
      <Button
        type="submit"
        className="w-full"
        status={busy ? "loading" : "idle"}
        disabled={disabled}
      >
        Connect
      </Button>
    </form>
  );
}
