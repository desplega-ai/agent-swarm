import { AlertCircle } from "lucide-react";
import { useState } from "react";
import { usePoolKeysSupport } from "@/api/hooks/use-pool-keys-support";
import { Spinner } from "@/components/kibo-ui/spinner";
import { CodexAccountsList } from "@/components/onboarding/codex-accounts-list";
import { DeviceCodePanel } from "@/components/providers/codex-device-code";
import { BrandLogo } from "@/components/shared/brand-logo";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { CopyIconButton } from "@/components/shared/copy-icon-button";
import { StatusLine } from "@/components/shared/status-icon";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { useCodexDeviceFlow } from "@/hooks/use-codex-device-flow";
import { useConfig } from "@/hooks/use-config";
import { DISCLOSURE_TITLE } from "./fields";
import type { AiCardProps } from "./model";
import { ProviderCard } from "./provider-card";

/** Global rows the CLI and the device flow write (`codex_oauth` is the legacy slot 0). */
const CODEX_SLOT_KEY = /^codex_oauth(_\d+)?$/i;

export function CodexCard({
  configs,
  onDeviceComplete,
  presence: _presence,
  onSaved: _onSaved,
  ...card
}: AiCardProps & { onDeviceComplete: () => void }) {
  const { config } = useConfig();
  const { flow, start: startFlow, reset } = useCodexDeviceFlow(onDeviceComplete);
  const accountsSupport = usePoolKeysSupport();
  // Remounts the CLI fallback open after a failed start, and keeps it open.
  const [cliKey, setCliKey] = useState(0);

  const apiUrl = config.apiUrl || window.location.origin;
  const cli = `npx @desplega.ai/agent-swarm codex-login --api-url ${apiUrl}`;
  const saved =
    flow.phase === "complete" ||
    configs.some((c) => c.scope === "global" && CODEX_SLOT_KEY.test(c.key));

  async function start() {
    if (!(await startFlow())) setCliKey((k) => k + 1);
  }

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
      {/* An older API has no account list route. */}
      {accountsSupport === "supported" ? (
        <CodexAccountsList
          onRemoved={(accounts) => {
            // The last account is gone: the card offers the first sign-in again.
            if (accounts.length === 0 && flow.phase === "complete") reset();
          }}
        />
      ) : null}

      {flow.phase === "idle" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {startButton(saved ? "Add another ChatGPT account" : "Sign in with ChatGPT")}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            First turn on "Allow device code login" in ChatGPT Settings, Security.
            <InfoTip content="Workspace admins control it for team workspaces." />
          </span>
        </div>
      ) : null}

      {flow.phase === "starting" ? (
        <Button type="button" disabled>
          <Spinner className="size-4" />
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <StatusLine tone="done">
            {flow.slot === undefined ? "Signed in" : `Signed in (Codex slot ${flow.slot})`}
          </StatusLine>
          {/* Starts a new device flow, which takes the next free slot. */}
          {startButton("Add another ChatGPT account")}
        </div>
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
        titleClassName={DISCLOSURE_TITLE}
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
