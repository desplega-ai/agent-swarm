import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, ExternalLink, Info, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { ONBOARDING_QUERY_KEY } from "@/api/hooks/use-onboarding";
import type { CodexDeviceStartResponse } from "@/api/types";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { useConfig } from "@/hooks/use-config";
import { BrandLogo } from "../../components/setup-card";
import { CopyIconButton } from "./fields";
import type { AiCardProps } from "./model";
import { ProviderCard } from "./provider-card";
import { WaitingLine } from "./waiting";

type CodexFlow =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "start_error"; error: string }
  | { phase: "polling"; flow: CodexDeviceStartResponse }
  | { phase: "complete"; slot?: number }
  | { phase: "failed"; error: string };

/** Global rows the CLI and the device flow write (`codex_oauth` is the legacy slot 0). */
const CODEX_SLOT_KEY = /^codex_oauth(_\d+)?$/i;

export function CodexCard({
  configs,
  onDeviceComplete,
  presence: _presence,
  onSaved: _onSaved,
  ...card
}: AiCardProps & { onDeviceComplete: () => void }) {
  const queryClient = useQueryClient();
  const { config } = useConfig();
  const [flow, setFlow] = useState<CodexFlow>({ phase: "idle" });
  // Remounts the CLI fallback open after a failed start, and keeps it open.
  const [cliKey, setCliKey] = useState(0);

  const apiUrl = config.apiUrl || window.location.origin;
  const cli = `npx @desplega.ai/agent-swarm codex-login --api-url ${apiUrl}`;
  const saved =
    flow.phase === "complete" ||
    configs.some((c) => c.scope === "global" && CODEX_SLOT_KEY.test(c.key));

  async function start() {
    setFlow({ phase: "starting" });
    try {
      setFlow({ phase: "polling", flow: await api.startCodexDevice() });
    } catch (err) {
      setFlow({
        phase: "start_error",
        error: err instanceof Error ? err.message : "Could not start the sign-in.",
      });
      setCliKey((k) => k + 1);
    }
  }

  // Poll while the card is mounted. The API calls upstream at most once per
  // interval, so a faster tick only returns `pending`.
  useEffect(() => {
    if (flow.phase !== "polling") return;
    const { flowId, intervalSeconds } = flow.flow;
    const delayMs = Math.max(2, intervalSeconds || 5) * 1000;
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const res = await api.pollCodexDevice(flowId);
        if (cancelled) return;
        if (res.status === "complete") {
          setFlow({ phase: "complete", slot: res.slot });
          onDeviceComplete();
          void queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
          void queryClient.invalidateQueries({ queryKey: ["configs"] });
          return;
        }
        if (res.status === "failed" || res.status === "expired") {
          const fallback =
            res.status === "expired"
              ? "The code expired. Start again to get a new one."
              : "Sign-in failed.";
          setFlow({ phase: "failed", error: res.error || fallback });
          void queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
          return;
        }
      } catch {
        // Transient error: keep polling. The API reports `expired` once the code times out.
      }
      if (!cancelled) timer = window.setTimeout(tick, delayMs);
    };

    timer = window.setTimeout(tick, delayMs);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [flow, onDeviceComplete, queryClient]);

  const startButton = (label: string) => (
    <Button type="button" onClick={start}>
      {label}
    </Button>
  );

  return (
    <ProviderCard
      {...card}
      card="codex"
      icon={<BrandLogo src="/harness-logos/codex.svg" />}
      title="Codex"
      subtitle="Device code login. No terminal needed."
      saved={saved}
    >
      {flow.phase !== "complete" ? (
        <AlertCallout tone="info" icon={Info}>
          Turn on "Allow device code login" in ChatGPT Settings, Security (workspace admins control
          it for team workspaces).
        </AlertCallout>
      ) : null}

      {flow.phase === "idle" ? (
        <div className="space-y-2">
          {saved ? (
            <p className="text-sm text-muted-foreground">
              A ChatGPT sign-in is already saved. Sign in again to add another account.
            </p>
          ) : null}
          {startButton("Sign in with ChatGPT")}
        </div>
      ) : null}

      {flow.phase === "starting" ? (
        <Button type="button" disabled>
          <Loader2 className="animate-spin" />
          Requesting a code
        </Button>
      ) : null}

      {flow.phase === "start_error" ? (
        <>
          <AlertCallout tone="error" icon={AlertCircle}>
            {flow.error} Use the command under "Other ways to sign in" instead.
          </AlertCallout>
          {startButton("Try again")}
        </>
      ) : null}

      {flow.phase === "polling" ? <DeviceCodePanel flow={flow.flow} /> : null}

      {flow.phase === "complete" ? (
        <AlertCallout tone="success" icon={CheckCircle2}>
          {flow.slot === undefined ? "Signed in." : `Signed in. Saved as Codex slot ${flow.slot}.`}
        </AlertCallout>
      ) : null}

      {flow.phase === "failed" ? (
        <>
          <AlertCallout tone="error" icon={AlertCircle}>
            {flow.error}
          </AlertCallout>
          {startButton("Try again")}
        </>
      ) : null}

      <CollapsibleSection
        key={cliKey}
        title="Other ways to sign in"
        defaultOpen={cliKey > 0}
        className="border-t border-border-subtle pt-3"
      >
        <div className="space-y-1.5 pt-1.5">
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs break-all">
              {cli}
            </code>
            <CopyIconButton value={cli} label="Copy command" />
          </div>
          <p className="text-xs text-muted-foreground">
            Run it on a machine with a browser. It stores the token in this swarm.
          </p>
        </div>
      </CollapsibleSection>
    </ProviderCard>
  );
}

function DeviceCodePanel({ flow }: { flow: CodexDeviceStartResponse }) {
  const urlLabel = flow.verificationUrl.replace(/^https?:\/\//, "");
  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-center justify-center gap-3">
        <span className="font-mono text-[28px] leading-none font-bold tracking-[0.18em]">
          {flow.userCode}
        </span>
        <CopyIconButton value={flow.userCode} label="Copy code" />
      </div>
      <p className="text-center text-sm text-muted-foreground">
        Enter this one-time code. It expires in 15 minutes.
      </p>
      <div className="flex justify-center">
        <Button asChild variant="outline" size="sm">
          <a href={flow.verificationUrl} target="_blank" rel="noreferrer noopener">
            Open {urlLabel}
            <ExternalLink />
          </a>
        </Button>
      </div>
      <output className="block border-t border-dashed border-border pt-3">
        <WaitingLine>Waiting for you to approve in ChatGPT…</WaitingLine>
      </output>
    </div>
  );
}
