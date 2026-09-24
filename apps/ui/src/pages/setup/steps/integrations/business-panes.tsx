import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useOAuthApps, useOAuthRedirectUri } from "@/api/hooks/use-script-connections";
import type { OAuthAppSummary, OAuthAuthorizationSummary } from "@/api/types";
import { StatusLine } from "@/components/onboarding/save-indicator";
import { CopyableField } from "@/components/shared/copyable-fields";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { OAuthInlineConnect } from "@/pages/connections/components/oauth-inline-connect";
import type { BusinessTool } from "./catalog";
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
  if (appsQ.isError) return <OpenConnections tool={tool} note="This API has no OAuth apps yet." />;

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
          <StepLine n={2}>
            Pick the preset, paste the client ID and secret, then authorize.
          </StepLine>
        </div>
      ) : null}
      <OAuthInlineConnect
        oauthApps={apps}
        value={authorizationId || active?.id || ""}
        onChange={setAuthorizationId}
        suggestedPresetId={tool.oauthPresetId}
        scopes={tool.scopes}
      />
    </div>
  );
}

/** Figma, Stripe, Salesforce, Shopify, Granola: guided setup ships later. */
export function ComingSoonPane({ tool }: { tool: BusinessTool }) {
  return <OpenConnections tool={tool} note="Guided setup coming soon." />;
}

function OpenConnections({ tool, note }: { tool: BusinessTool; note: string }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted-foreground">
        {note} Connect {tool.name} from Connections for now.
      </p>
      <Button asChild variant="outline" size="sm">
        {/* A new tab keeps setup open in this one. */}
        <Link to="/connections" target="_blank" rel="noopener noreferrer">
          Open Connections
          <ExternalLink />
        </Link>
      </Button>
    </div>
  );
}
