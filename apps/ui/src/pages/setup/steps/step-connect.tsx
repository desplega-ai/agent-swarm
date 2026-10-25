import { ExternalLink, Plug, RotateCw, UserRound, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useStatus } from "@/api/hooks/use-status";
import type { OnboardingResponse } from "@/api/types";
import { IdentityForm } from "@/components/identity/identity-form";
import { Spinner } from "@/components/kibo-ui/spinner";
import { setupExitHref } from "@/components/onboarding/onboarding-redirect";
import { FadeIn } from "@/components/shared/fade-in";
import { LocalNetworkHelp, LocalNetworkNotice } from "@/components/shared/local-network-help";
import { SecretInput } from "@/components/shared/secret-input";
import { SetupCard } from "@/components/shared/setup-card";
import { StatusIcon } from "@/components/shared/status-icon";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useContinueBlocker } from "@/hooks/use-autosave";
import { useConfig } from "@/hooks/use-config";
import { connectionName } from "@/lib/config";
import { needsLocalNetworkPermission, withAddressSpace } from "@/lib/local-network";
import { httpUrlError } from "../components/http-url";
import { DEFAULT_SWARM_NAME, swarmDisplayName } from "../components/swarm-name";
import type { StepProps } from "../step-contract";

export interface StepConnectProps {
  /** Null until a connection exists (the shell renders step 1 before any API call works). */
  onboarding: OnboardingResponse | null;
  /** Called after `/health` passes and the connection is stored and active. */
  onConnected: () => void;
  /** Present once connected. Used to record the step when the API did not derive it. */
  act?: StepProps["act"];
  /** Holds Continue until the operator picks who they are. */
  setContinueBlocker: StepProps["setContinueBlocker"];
  /** Continue submits "Who are you?" (pick or create the user), then the shell moves on. */
  setContinueAction: StepProps["setContinueAction"];
}

export function StepConnect({
  onboarding,
  onConnected,
  act,
  setContinueBlocker,
  setContinueAction,
}: StepConnectProps) {
  const { isConfigured } = useConfig();
  if (!isConfigured) return <ConnectForm onConnected={onConnected} />;
  return (
    <div className="space-y-3">
      <ConnectedSummary onboarding={onboarding} act={act} />
      <WhoAreYou setContinueBlocker={setContinueBlocker} setContinueAction={setContinueAction} />
    </div>
  );
}

function ConnectedSummary({
  onboarding,
  act,
}: {
  onboarding: OnboardingResponse | null;
  act?: StepProps["act"];
}) {
  const { config, connectionLocked } = useConfig();
  const { data: status } = useStatus({ pollIntervalMs: 30_000 });
  const connectStatus = onboarding?.state.steps.connect.status;

  // Existing installs skip server-side derivation, so "Run setup again" would
  // leave step 1 open. A working authenticated read is the signal: record it once.
  const recorded = useRef(false);
  useEffect(() => {
    if (!act || !connectStatus || connectStatus === "done" || recorded.current) return;
    recorded.current = true;
    act({ action: "complete", step: "connect", method: "api_key" }).catch(() => {});
  }, [act, connectStatus]);

  // The API host until step 2 names the swarm. The stored connection keeps
  // its own name for the connection switcher.
  const swarmName = swarmDisplayName(status?.identity.name);
  const name = swarmName === DEFAULT_SWARM_NAME ? connectionName(config.apiUrl) : swarmName;
  return (
    <SetupCard
      icon={<Plug className="size-4" />}
      title={name}
      description={
        <span className="block truncate font-mono text-[12px]" title={config.apiUrl}>
          {config.apiUrl}
        </span>
      }
      actions={
        connectionLocked ? null : (
          <Button asChild variant="ghost" size="sm" className="text-muted-foreground">
            {/* A new tab keeps setup open in this one. */}
            <Link
              to={setupExitHref("/settings/connections")}
              target="_blank"
              rel="noopener noreferrer"
            >
              Manage
              <ExternalLink />
            </Link>
          </Button>
        )
      }
      status={<StatusIcon tone="done" label={`Connected to ${name}`} />}
    />
  );
}

/**
 * Whether step 1 must ask "Who are you?". Users ship in 1.76.0. A token or
 * the deployment can fix the identity (`locked`), and then nobody picks.
 */
export function useIdentityPick() {
  const { state, locked } = useCurrentUser();
  const gate = useFeatureGate("1.76.0");
  // No version yet and no error: the `/health` read is still in flight.
  const checking = !gate.supported && gate.currentVersion === null && !gate.isError;
  const needed = gate.supported && !locked && state !== "ready";
  return {
    supported: gate.supported,
    /** The API version is not known yet. */
    checking,
    /** Not decided yet: the version or the user list is still loading. */
    resolving: checking || (needed && state === "pending"),
    /** The operator must pick or create a user. */
    needed,
  };
}

/**
 * "Who are you?" right after the connection: pick or create the user the
 * swarm attributes tasks to. One flat form: the footer Continue (or Enter in
 * a field) submits it and moves on. Holds Continue until the answers are
 * complete. Skipped when a token or the deployment fixes the identity, or the
 * API is older than 1.76.0 (no users).
 */
function WhoAreYou({
  setContinueBlocker,
  setContinueAction,
}: Pick<StepConnectProps, "setContinueBlocker" | "setContinueAction">) {
  const { state, user, locked } = useCurrentUser();
  const { supported, checking, needed } = useIdentityPick();
  const [switching, setSwitching] = useState(false);
  // What the form still needs (from `IdentityForm`), or null when Continue submits it.
  const [formHold, setFormHold] = useState<string | null>("Enter your email.");

  const loadingUsers = needed && state === "pending";
  useContinueBlocker(
    setContinueBlocker,
    checking
      ? "Checking your server…"
      : !needed && !switching
        ? null
        : loadingUsers
          ? "Loading users…"
          : formHold,
    { busy: checking || loadingUsers },
  );

  if (!supported) return null;

  if (user && (locked || (state === "ready" && !switching))) {
    return (
      <FadeIn key="signed-in">
        <SetupCard
          icon={<UserRound className="size-4" />}
          title={
            <>
              <span className="font-normal text-muted-foreground">Signed in as</span> {user.name}
            </>
          }
          description={user.email ?? undefined}
          actions={
            locked ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setSwitching(true)}
              >
                Switch
              </Button>
            )
          }
          status={
            <StatusIcon
              tone="done"
              label={
                locked
                  ? "Your API key is bound to this user."
                  : "The swarm attributes your tasks to this user."
              }
            />
          }
        />
      </FadeIn>
    );
  }
  if (locked) return null;

  return (
    <FadeIn key="pick">
      <SetupCard
        icon={<UserRound className="size-4" />}
        title="Who are you?"
        description="Enter your email. The swarm attributes your tasks to this user."
        actions={
          switching ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setSwitching(false)}
            >
              Cancel
            </Button>
          ) : null
        }
        status={<StatusIcon tone={state === "pending" ? "busy" : "none"} label="Loading users…" />}
      >
        {/* The marker lets Enter in its fields run the footer Continue. */}
        <div data-enter-continues>
          <IdentityForm
            surface="setup"
            onDone={() => setSwitching(false)}
            continueWith={{
              setAction: (submit) => setContinueAction(submit, { unlocks: true }),
              setHold: setFormHold,
            }}
          />
        </div>
      </SetupCard>
    </FadeIn>
  );
}

// No success phase: storing the connection swaps this form for the connected
// summary in the same render. `network`: no response at all (the API is down,
// a wrong address, CORS, or the browser blocked local network access).
type Probe =
  | { phase: "idle" | "running" }
  | { phase: "error"; title: string; detail: string; network: boolean };

const UNREACHABLE = "Your swarm is not reachable yet";

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Connection failed";
}

function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const { addConnection, switchConnection, setupLink, clearSetupLink } = useConfig();
  // The install link (`/setup?apiUrl=&apiKey=`) fills the fields.
  const [apiUrl, setApiUrl] = useState(setupLink?.apiUrl ?? "http://localhost:3013");
  const [apiKey, setApiKey] = useState(setupLink?.apiKey ?? "");
  const [probe, setProbe] = useState<Probe>({ phase: "idle" });

  const url = apiUrl.trim().replace(/\/+$/, "");
  const urlValid = httpUrlError(url) === null;
  const running = probe.phase === "running";
  // The hosted (https) dashboard and an API on this machine or the local network.
  const asksPermission = urlValid && needsLocalNetworkPermission(url, window.location.href);

  async function handleTest() {
    if (!urlValid || !apiKey || running) return;
    setProbe({ phase: "running" });
    // For a local API, the first request opens the browser's permission prompt.
    const init = withAddressSpace(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    let res: Response;
    try {
      res = await fetch(`${url}/health`, init);
    } catch (err) {
      setProbe({ phase: "error", title: UNREACHABLE, detail: errorText(err), network: true });
      return;
    }
    try {
      if (!res.ok) throw new Error(`GET /health returned ${res.status}`);
      // A JSON body tells the API apart from a host that answers every path
      // with HTML (this dashboard, for example).
      await res.json().catch(() => {
        throw new Error("GET /health did not return JSON");
      });
    } catch (err) {
      setProbe({ phase: "error", title: UNREACHABLE, detail: errorText(err), network: false });
      return;
    }

    try {
      // `/health` is public, so one authenticated read checks the key before
      // it is stored. Any status but 401/403 means the key was accepted.
      const auth = await fetch(`${url}/api/onboarding`, init);
      if (auth.status === 401 || auth.status === 403) {
        setProbe({
          phase: "error",
          title: "The server rejected this API key.",
          detail: `GET /api/onboarding returned ${auth.status}`,
          network: false,
        });
        return;
      }
      // Named after its host. The connection switcher can rename it.
      const created = addConnection({ name: connectionName(url), apiUrl: url, apiKey });
      switchConnection(created.id);
      clearSetupLink();
    } catch (err) {
      setProbe({
        phase: "error",
        title: "Could not save the connection.",
        detail: errorText(err),
        network: false,
      });
      return;
    }
    onConnected();
  }

  return (
    <SetupCard
      icon={<Plug className="size-4" />}
      title="API connection"
      status={
        <StatusIcon
          tone={running ? "busy" : probe.phase === "error" ? "error" : "none"}
          label={running ? "Checking the server…" : "The last check failed."}
        />
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleTest();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsRow
            label={
              <>
                API URL
                <InfoTip content="The dashboard checks GET /health on this address." />
              </>
            }
            htmlFor="setup-api-url"
            helper={
              apiUrl.trim() && !urlValid ? (
                <span className="text-status-error-strong">Start with http:// or https://.</span>
              ) : undefined
            }
          >
            <Input
              id="setup-api-url"
              inputMode="url"
              autoComplete="url"
              spellCheck={false}
              value={apiUrl}
              onChange={(event) => setApiUrl(event.target.value)}
              aria-invalid={Boolean(apiUrl.trim()) && !urlValid}
              disabled={running}
              className="font-mono"
            />
          </SettingsRow>
          <SettingsRow
            label={
              <>
                API key
                <InfoTip
                  content={
                    <>
                      The value of <code className="font-mono">AGENT_SWARM_API_KEY</code> on the
                      server. Kept in this browser only.
                    </>
                  }
                />
              </>
            }
            htmlFor="setup-api-key"
          >
            <SecretInput
              id="setup-api-key"
              value={apiKey}
              onChange={setApiKey}
              disabled={running}
            />
          </SettingsRow>
        </div>

        {asksPermission && probe.phase !== "error" ? <LocalNetworkNotice apiUrl={url} /> : null}

        {/* A link can carry any host, so it never connects on its own: the
            person sees the address and chooses to connect. */}
        {setupLink && urlValid ? (
          <p className="text-sm text-muted-foreground">
            Your install link fills in{" "}
            <span className="font-mono text-foreground">{connectionName(url)}</span>. Connect only
            to a swarm you started.
          </p>
        ) : null}

        <div>
          <Button type="submit" disabled={!urlValid || !apiKey || running}>
            {running ? <Spinner className="size-4" /> : null}
            Connect
          </Button>
        </div>

        {probe.phase === "error" ? (
          <AlertCallout
            tone="error"
            icon={XCircle}
            title={probe.title}
            action={
              <Button type="button" variant="outline" size="sm" onClick={() => void handleTest()}>
                <RotateCw />
                Retry
              </Button>
            }
          >
            <span className="block font-mono break-all">{probe.detail}</span>
            {probe.network ? (
              <>
                <p className="mt-1">Check that your swarm is running and the URL is right.</p>
                <LocalNetworkHelp apiUrl={url} />
              </>
            ) : null}
          </AlertCallout>
        ) : null}
      </form>
    </SetupCard>
  );
}
