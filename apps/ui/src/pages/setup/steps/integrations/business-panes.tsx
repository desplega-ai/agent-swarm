import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useOAuthApps, useOAuthRedirectUri } from "@/api/hooks/use-script-connections";
import type { OAuthAppSummary, OAuthAuthorizationSummary } from "@/api/types";
import { setupExitHref } from "@/components/onboarding/onboarding-redirect";
import { BrandLogo } from "@/components/shared/brand-logo";
import { CopyableField } from "@/components/shared/copyable-fields";
import { StatusLine } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { OAuthInlineConnect } from "@/pages/connections/components/oauth-inline-connect";
import { type BusinessTool, COMING_SOON_TOOLS } from "./catalog";
import { StepLine } from "./pane-parts";

/** The first active OAuth authorization of a provider across its apps, or null. */
export function activeAuthorization(
  apps: OAuthAppSummary[],
  provider: string,
): OAuthAuthorizationSummary | null {
  return (
    apps
      .filter((app) => app.provider === provider)
      .flatMap((app) => app.authorizations ?? [])
      .find((z) => z.status === "active") ?? null
  );
}

/**
 * Gmail and Microsoft 365: create the OAuth app from the curated preset and
 * authorize an account, inline. Scripts and agents use it through Connections.
 */
export function OAuthToolPane({ tool }: { tool: BusinessTool }) {
  const appsQ = useOAuthApps();
  const provider = tool.oauthPresetId ?? "";
  const apps = (appsQ.data ?? []).filter((app) => app.provider === provider);
  const active = activeAuthorization(apps, provider);
  const redirectQ = useOAuthRedirectUri();
  const [authorizationId, setAuthorizationId] = useState("");

  if (appsQ.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-2/3" />
      </div>
    );
  }
  if (appsQ.isError) {
    return (
      <OpenConnections
        note={`This API has no OAuth apps yet. Connect ${tool.name} from Connections for now.`}
      />
    );
  }

  return (
    <div className="space-y-4">
      {active ? (
        <StatusLine tone="done">
          Connected{active.accountEmail ? ` as ${active.accountEmail}` : ""}.
        </StatusLine>
      ) : null}
      {apps.length === 0 && redirectQ.data ? (
        <div className="space-y-3">
          <StepLine n={1}>Create an OAuth client with this redirect URI.</StepLine>
          <CopyableField label="Redirect URI" value={redirectQ.data} />
          <StepLine n={2}>Paste the client ID and secret, then authorize.</StepLine>
        </div>
      ) : null}
      <OAuthInlineConnect
        oauthApps={apps}
        value={authorizationId || active?.id || ""}
        onChange={setAuthorizationId}
        suggestedPresetId={tool.oauthPresetId}
        lockPreset
        scopes={tool.scopes}
      />
    </div>
  );
}

/** "More coming": the tools whose guided setup ships later. */
export function ComingSoonPane() {
  return (
    <div className="space-y-4">
      <ul className="space-y-2">
        {COMING_SOON_TOOLS.map((tool) => (
          <li key={tool.name} className="flex items-center gap-2 text-sm">
            <BrandLogo src={tool.logo} className="size-4" />
            <span className="font-medium">{tool.name}</span>
            <span className="min-w-0 truncate text-muted-foreground">{tool.purpose}</span>
          </li>
        ))}
      </ul>
      <OpenConnections note="Connect them from Connections for now." />
    </div>
  );
}

function OpenConnections({ note }: { note: string }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted-foreground">{note}</p>
      <Button asChild variant="outline" size="sm">
        {/* A new tab keeps setup open in this one. */}
        <Link to={setupExitHref("/connections")} target="_blank" rel="noopener noreferrer">
          Open Connections
          <ExternalLink />
        </Link>
      </Button>
    </div>
  );
}
