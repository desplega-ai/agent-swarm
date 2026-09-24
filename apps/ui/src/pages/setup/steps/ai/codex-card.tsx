import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { ONBOARDING_QUERY_KEY } from "@/api/hooks/use-onboarding";
import type { CodexDeviceStartResponse } from "@/api/types";
import { StatusLine } from "@/components/onboarding/save-indicator";
import { BrandLogo } from "@/components/onboarding/setup-card";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { useConfig } from "@/hooks/use-config";
import { CopyIconButton } from "./fields";
import type { AiCardProps } from "./model";
import { ProviderCard } from "./provider-card";

type CodexFlow =
  | { phase: "idle" }
  | { phase: "starting" }
  | { phase: "start_error"; error: string }
  | { phase: "polling"; flow: CodexDeviceStartResponse }
  | { phase: "complete"; slot?: number }
  | { phase: "failed"; error: string };

/** Global rows the CLI and the device flow write (`codex_oauth` is the legacy slot 0). */
const CODEX_SLOT_KEY = /^codex_oauth(_\d+)?$/i;

const EXPIRED_MESSAGE = "The code expired. Start again to get a new one.";
/** Consecutive failed poll requests before the card stops and offers "Try again". */
const MAX_POLL_ERRORS = 3;

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

  // Poll while the card is mounted, until the code expires. The API calls
  // upstream at most once per interval, so a faster tick only returns `pending`.
  useEffect(() => {
    if (flow.phase !== "polling") return;
    const { flowId, intervalSeconds, expiresAt } = flow.flow;
    const delayMs = Math.max(2, intervalSeconds || 5) * 1000;
    const expiresAtMs = Date.parse(expiresAt);
    let cancelled = false;
    let errors = 0;
    let timer: number | undefined;

    const tick = async () => {
      if (Date.now() >= expiresAtMs) {
        setFlow({ phase: "failed", error: EXPIRED_MESSAGE });
        return;
      }
      try {
        const res = await api.pollCodexDevice(flowId);
        if (cancelled) return;
        errors = 0;
        if (res.status === "complete") {
          setFlow({ phase: "complete", slot: res.slot });
          onDeviceComplete();
          void queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
          void queryClient.invalidateQueries({ queryKey: ["configs"] });
          return;
        }
        if (res.status === "failed" || res.status === "expired") {
          const fallback = res.status === "expired" ? EXPIRED_MESSAGE : "Sign-in failed.";
          setFlow({ phase: "failed", error: res.error || fallback });
          void queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
          return;
        }
      } catch (err) {
        if (cancelled) return;
        // One failed request can be transient. Several in a row mean the API is gone.
        errors += 1;
        if (errors >= MAX_POLL_ERRORS) {
          const detail = err instanceof Error ? ` ${err.message}` : "";
          setFlow({ phase: "failed", error: `Could not check the sign-in.${detail}` });
          return;
        }
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
      {flow.phase === "idle" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {startButton(saved ? "Add another ChatGPT account" : "Sign in with ChatGPT")}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Needs device code login in ChatGPT
            <InfoTip content='Turn on "Allow device code login" in ChatGPT Settings, Security. Workspace admins control it for team workspaces.' />
          </span>
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
        <StatusLine tone="done">
          {flow.slot === undefined ? "Signed in" : `Signed in (Codex slot ${flow.slot})`}
        </StatusLine>
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
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Run it on a machine with a browser.
            <InfoTip content="The command signs in to ChatGPT and stores the token in this swarm." />
          </p>
        </div>
      </CollapsibleSection>
    </ProviderCard>
  );
}

function DeviceCodePanel({ flow }: { flow: CodexDeviceStartResponse }) {
  const urlLabel = flow.verificationUrl.replace(/^https?:\/\//, "");
  // Re-read on every render; the step re-renders on each onboarding poll.
  const minutes = Math.ceil((Date.parse(flow.expiresAt) - Date.now()) / 60_000);
  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div className="flex items-center justify-center gap-3">
        <span className="font-mono text-[28px] leading-none font-bold tracking-[0.18em]">
          {flow.userCode}
        </span>
        <CopyIconButton value={flow.userCode} label="Copy code" />
      </div>
      <p className="text-center text-sm text-muted-foreground">
        Enter this one-time code.
        {minutes > 0 ? ` It expires in ${minutes} minute${minutes === 1 ? "" : "s"}.` : null}
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
        <StatusLine tone="busy">Waiting for you to approve in ChatGPT…</StatusLine>
      </output>
    </div>
  );
}
