import { CheckCircle2, Eye, EyeOff, Loader2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { OnboardingResponse } from "@/api/types";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsRow } from "@/components/ui/settings-row";
import { useConfig } from "@/hooks/use-config";
import { generateSlug } from "@/lib/slugs";
import { SetupCard, SetupChip } from "../components/setup-card";
import type { StepProps } from "../step-contract";

export interface StepConnectProps {
  /** Null until a connection exists (the shell renders step 1 before any API call works). */
  onboarding: OnboardingResponse | null;
  /** Called after `/health` passes and the connection is stored and active. */
  onConnected: () => void;
  /** Present once connected. Used to record the step when the API did not derive it. */
  act?: StepProps["act"];
}

export function StepConnect({ onboarding, onConnected, act }: StepConnectProps) {
  const { isConfigured } = useConfig();
  if (isConfigured) return <ConnectedSummary onboarding={onboarding} act={act} />;
  return <ConnectForm onConnected={onConnected} />;
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

  return (
    <SetupCard title="API connection" status={<SetupChip tone="success">Connected</SetupChip>}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <CheckCircle2 className="size-4 shrink-0 text-status-success-strong" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-sm">
          Connected to <span className="font-medium">{activeConnection?.name ?? "your API"}</span>{" "}
          at <span className="font-mono text-[13px] break-all">{config.apiUrl}</span>
        </p>
        {connectionLocked ? null : (
          <Button asChild variant="outline" size="sm">
            <Link to="/settings/connections">Manage connections</Link>
          </Button>
        )}
      </div>
    </SetupCard>
  );
}

type Probe =
  | { phase: "idle" | "running" }
  | { phase: "error"; title: string; detail: string }
  | { phase: "ok"; detail: string };

const URL_RE = /^https?:\/\/\S+$/;

function ConnectForm({ onConnected }: { onConnected: () => void }) {
  const { addConnection, switchConnection } = useConfig();
  const [placeholder] = useState(() => generateSlug());
  const [name, setName] = useState("");
  const [apiUrl, setApiUrl] = useState("http://localhost:3013");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [probe, setProbe] = useState<Probe>({ phase: "idle" });

  const url = apiUrl.trim().replace(/\/+$/, "");
  const urlValid = URL_RE.test(url);
  const running = probe.phase === "running";

  async function handleTest() {
    if (!urlValid || !apiKey || running) return;
    setProbe({ phase: "running" });
    const started = performance.now();
    const headers = { Authorization: `Bearer ${apiKey}` };
    let version: string | undefined;
    try {
      const res = await fetch(`${url}/health`, { headers });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      version = ((await res.json()) as { version?: string }).version;
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

    const latency = Math.round(performance.now() - started);
    setProbe({
      phase: "ok",
      detail: `200 OK${version ? ` · agent-swarm v${version}` : ""} · ${latency} ms`,
    });
    onConnected();
  }

  const chip =
    probe.phase === "ok" ? (
      <SetupChip tone="success">Connected</SetupChip>
    ) : probe.phase === "error" ? (
      <SetupChip tone="error">Failed</SetupChip>
    ) : (
      <SetupChip>Not tested</SetupChip>
    );

  return (
    <SetupCard title="API connection" status={chip}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleTest();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsRow
            label="Connection name"
            htmlFor="setup-connection-name"
            helper="Shows in the connection switcher. Optional."
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
            label="API URL"
            htmlFor="setup-api-url"
            helper={
              apiUrl.trim() && !urlValid ? (
                <span className="text-status-error-strong">Start with http:// or https://.</span>
              ) : (
                <>
                  The dashboard probes <code className="font-mono">GET /health</code> on this
                  address.
                </>
              )
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
          label="API key"
          htmlFor="setup-api-key"
          helper={
            <>
              The value of <code className="font-mono">AGENT_SWARM_API_KEY</code> on the server.
              Kept in this browser only.
            </>
          }
        >
          <div className="relative">
            <Input
              id="setup-api-key"
              type={showKey ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={running}
              className="pr-10 font-mono"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setShowKey((shown) => !shown)}
              aria-label={showKey ? "Hide API key" : "Show API key"}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground"
            >
              {showKey ? <EyeOff /> : <Eye />}
            </Button>
          </div>
        </SettingsRow>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button type="submit" disabled={!urlValid || !apiKey || running}>
            {running ? <Loader2 className="animate-spin" /> : null}
            Test connection
          </Button>
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            GET {urlValid ? url : "..."}/health
          </span>
        </div>

        {probe.phase === "error" ? (
          <AlertCallout tone="error" icon={XCircle} title={probe.title}>
            <span className="font-mono break-all">{probe.detail}</span>
          </AlertCallout>
        ) : null}
        {probe.phase === "ok" ? (
          <AlertCallout
            tone="success"
            icon={CheckCircle2}
            title="Server answered. Connection saved."
          >
            <span className="font-mono">{probe.detail}</span>
          </AlertCallout>
        ) : null}
      </form>
    </SetupCard>
  );
}
