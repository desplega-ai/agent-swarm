import { ExternalLink, Loader2, Plug, UserRound, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import type { OnboardingResponse } from "@/api/types";
import { IdentityForm } from "@/components/identity/identity-form";
import { FadeIn } from "@/components/onboarding/fade-in";
import { StatusIcon } from "@/components/onboarding/save-indicator";
import { SecretInput } from "@/components/onboarding/secret-field";
import { SetupCard } from "@/components/onboarding/setup-card";
import { useContinueBlocker } from "@/components/onboarding/use-autosave";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { generateSlug } from "@/lib/slugs";
import { httpUrlError } from "../components/http-url";
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
}

export function StepConnect({
  onboarding,
  onConnected,
  act,
  setContinueBlocker,
}: StepConnectProps) {
  const { isConfigured } = useConfig();
  if (!isConfigured) return <ConnectForm onConnected={onConnected} />;
  return (
    <div className="space-y-3">
      <ConnectedSummary onboarding={onboarding} act={act} />
      <WhoAreYou setContinueBlocker={setContinueBlocker} />
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
  const { activeConnection, config, connectionLocked } = useConfig();
  const connectStatus = onboarding?.state.steps.connect.status;

  // Existing installs skip server-side derivation, so "Run setup again" would
  // leave step 1 open. A working authenticated read is the signal: record it once.
  const recorded = useRef(false);
  useEffect(() => {
    if (!act || !connectStatus || connectStatus === "done" || recorded.current) return;
    recorded.current = true;
    act({ action: "complete", step: "connect", method: "api_key" }).catch(() => {});
  }, [act, connectStatus]);

  const name = activeConnection?.name ?? "your API";
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
            <Link to="/settings/connections" target="_blank" rel="noopener noreferrer">
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
 * swarm attributes tasks to. Holds Continue until a user is ready. Skipped
 * when a token or the deployment fixes the identity, or the API is older than
 * 1.76.0 (no users).
 */
function WhoAreYou({ setContinueBlocker }: Pick<StepConnectProps, "setContinueBlocker">) {
  const { state, user, locked } = useCurrentUser();
  const { supported, checking, needed } = useIdentityPick();
  const [switching, setSwitching] = useState(false);

  const loadingUsers = needed && state === "pending";
  useContinueBlocker(
    setContinueBlocker,
    checking
      ? "Checking your server…"
      : !needed
        ? null
        : loadingUsers
          ? "Loading users…"
          : "Pick who you are",
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
        description="The swarm attributes your tasks to this user."
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
        <IdentityForm
          autoFocus={false}
          instant
          onDone={() => setSwitching(false)}
          submitLabels={{ create: "Create user" }}
        />
      </SetupCard>
    </FadeIn>
  );
}

// No success phase: storing the connection swaps this form for the connected
// summary in the same render.
type Probe = { phase: "idle" | "running" } | { phase: "error"; title: string; detail: string };

function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const { addConnection, switchConnection } = useConfig();
  const [placeholder] = useState(() => generateSlug());
  const [name, setName] = useState("");
  const [apiUrl, setApiUrl] = useState("http://localhost:3013");
  const [apiKey, setApiKey] = useState("");
  const [probe, setProbe] = useState<Probe>({ phase: "idle" });

  const url = apiUrl.trim().replace(/\/+$/, "");
  const urlValid = httpUrlError(url) === null;
  const running = probe.phase === "running";

  async function handleTest() {
    if (!urlValid || !apiKey || running) return;
    setProbe({ phase: "running" });
    const headers = { Authorization: `Bearer ${apiKey}` };
    try {
      const res = await fetch(`${url}/health`, { headers });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      // A JSON body tells the API apart from a host that answers every path
      // with HTML (this dashboard, for example).
      await res.json();
    } catch (err) {
      setProbe({
        phase: "error",
        title: "Could not reach that address.",
        detail: err instanceof Error ? err.message : "Connection failed",
      });
      return;
    }

    try {
      // `/health` is public, so one authenticated read checks the key before
      // it is stored. Any status but 401/403 means the key was accepted.
      const auth = await fetch(`${url}/api/onboarding`, { headers });
      if (auth.status === 401 || auth.status === 403) {
        setProbe({
          phase: "error",
          title: "The server rejected this API key.",
          detail: `GET /api/onboarding returned ${auth.status}`,
        });
        return;
      }
      const created = addConnection({ name: name.trim() || placeholder, apiUrl: url, apiKey });
      switchConnection(created.id);
    } catch (err) {
      setProbe({
        phase: "error",
        title: "Could not save the connection.",
        detail: err instanceof Error ? err.message : "Connection failed",
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
                Connection name
                <InfoTip content="Optional. Shows in the connection switcher." />
              </>
            }
            htmlFor="setup-connection-name"
          >
            <Input
              id="setup-connection-name"
              placeholder={placeholder}
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={running}
            />
          </SettingsRow>
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
        </div>

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
          <SecretInput id="setup-api-key" value={apiKey} onChange={setApiKey} disabled={running} />
        </SettingsRow>

        <div>
          <Button type="submit" disabled={!urlValid || !apiKey || running}>
            {running ? <Loader2 className="animate-spin" /> : null}
            Connect
          </Button>
        </div>

        {probe.phase === "error" ? (
          <AlertCallout tone="error" icon={XCircle} title={probe.title}>
            <span className="font-mono break-all">{probe.detail}</span>
          </AlertCallout>
        ) : null}
      </form>
    </SetupCard>
  );
}
