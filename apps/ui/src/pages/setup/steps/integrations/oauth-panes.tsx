import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { useJiraTrackerStatus } from "@/api/hooks/use-jira-status";
import { useLinearTrackerStatus } from "@/api/hooks/use-linear-status";
import { CopyableField } from "@/components/shared/copyable-fields";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfig } from "@/hooks/use-config";
import { JIRA_FIELDS, LINEAR_FIELDS, type SetupFieldSpec } from "./catalog";
import { ConnectedGate, ExternalTextLink, StepLine } from "./pane-parts";
import { FieldGrid } from "./setup-field";
import { type PaneProps, useConfigForm } from "./use-config-form";

interface OAuthPaneProps extends PaneProps {
  /** Error from the OAuth return (`?oauth=error`), shown until the pane remounts. */
  oauthError?: string | null;
}

export function LinearPane(props: OAuthPaneProps) {
  const status = useLinearTrackerStatus();
  return (
    <OAuthPane
      {...props}
      provider="linear"
      name="Linear"
      specs={LINEAR_FIELDS}
      serverRedirectUri={status.data?.redirectUri}
      urlLabel="Callback URL"
      createLine={
        <>
          Create an OAuth app at{" "}
          <ExternalTextLink href="https://linear.app/settings/api">
            linear.app/settings/api
          </ExternalTextLink>{" "}
          with this callback URL.
        </>
      }
      connectedSummary="Connected. Issues and status sync are on."
    />
  );
}

export function JiraPane(props: OAuthPaneProps) {
  const status = useJiraTrackerStatus();
  const site = hostOf(status.data?.siteUrl);
  return (
    <OAuthPane
      {...props}
      provider="jira"
      name="Jira"
      specs={JIRA_FIELDS}
      serverRedirectUri={status.data?.redirectUri}
      urlLabel="Redirect URI"
      createLine={
        <>
          Create a 3LO app at{" "}
          <ExternalTextLink href="https://developer.atlassian.com/console/myapps/">
            developer.atlassian.com
          </ExternalTextLink>{" "}
          with this redirect URI.
        </>
      }
      connectedSummary={
        site ? `Connected to ${site}.` : "Connected. Issues and status sync are on."
      }
    />
  );
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function OAuthPane({
  configs,
  presence,
  connected,
  oauthError,
  provider,
  name,
  specs,
  serverRedirectUri,
  urlLabel,
  createLine,
  connectedSummary,
}: OAuthPaneProps & {
  provider: "linear" | "jira";
  name: string;
  specs: SetupFieldSpec[];
  serverRedirectUri?: string;
  urlLabel: string;
  createLine: ReactNode;
  connectedSummary: string;
}) {
  const form = useConfigForm(configs, presence);
  const { config } = useConfig();
  const apiUrl = config.apiUrl.replace(/\/+$/, "");
  // The server knows the public callback (`*_REDIRECT_URI` or the public MCP
  // URL). It only answers once the client ID is set, so fall back to apiUrl.
  const callbackUrl = serverRedirectUri || `${apiUrl}/api/trackers/${provider}/callback`;
  const prefix = provider.toUpperCase();
  // Both fields save themselves; Connect opens once both are stored.
  const canConnect = form.isSaved(`${prefix}_CLIENT_ID`) && form.isSaved(`${prefix}_CLIENT_SECRET`);

  function connect() {
    const back = `${window.location.origin}/setup?step=5&integration=${provider}`;
    window.location.assign(
      `${apiUrl}/api/trackers/${provider}/authorize?redirect=${encodeURIComponent(back)}`,
    );
  }

  const connectButton = (
    <Button type="button" onClick={connect} disabled={!canConnect}>
      Connect {name}
    </Button>
  );

  return (
    <>
      {oauthError ? (
        <AlertCallout tone="error" icon={AlertCircle} title={`${name} did not connect.`}>
          <span className="font-mono text-xs">{oauthError}</span>
        </AlertCallout>
      ) : null}
      <ConnectedGate connected={connected} summary={connectedSummary}>
        <div className="space-y-3">
          <StepLine n={1}>{createLine}</StepLine>
          <CopyableField label={urlLabel} value={callbackUrl} />
        </div>
        <div className="space-y-3">
          <StepLine n={2}>Paste the client ID and secret.</StepLine>
          <FieldGrid specs={specs} form={form} />
        </div>
        <div className="space-y-3">
          <StepLine n={3}>Approve on the {name} consent screen.</StepLine>
          {canConnect ? (
            connectButton
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* A disabled button gets no pointer events: the span carries the tooltip. */}
                <span className="inline-flex">{connectButton}</span>
              </TooltipTrigger>
              <TooltipContent>Add the client ID and secret first.</TooltipContent>
            </Tooltip>
          )}
        </div>
      </ConnectedGate>
    </>
  );
}
