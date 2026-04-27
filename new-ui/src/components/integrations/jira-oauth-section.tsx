import { AlertCircle, Check, Copy, ExternalLink, Link as LinkIcon, RefreshCw } from "lucide-react";
import { useState } from "react";
import { buildJiraAuthorizeUrl, useJiraTrackerStatus } from "@/api/hooks/use-jira-status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// Jira OAuth connection card — renders above the generic field form.
//
// Backend shape: see src/http/trackers/jira.ts handleJiraTracker.
// Like Linear, Jira has no disconnect endpoint, so we show a "Re-authenticate"
// fallback. Distinct from Linear: we surface cloudId + siteUrl + webhook count
// + manage:jira-webhook scope hint for the manual-registration fallback.
// ---------------------------------------------------------------------------

function formatTokenExpiry(expiry: string | null): string | null {
  if (!expiry) return null;
  const d = new Date(expiry);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

export function JiraOAuthSection() {
  const { data, isLoading, isError, error, refetch, isFetching } = useJiraTrackerStatus();
  const [copied, setCopied] = useState(false);

  async function handleCopyWebhook() {
    if (!data?.webhookUrl) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(data.webhookUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // Clipboard unavailable — silent.
    }
  }

  function handleAuthorize() {
    window.location.href = buildJiraAuthorizeUrl();
  }

  if (isLoading) {
    return (
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
          Connection
        </h2>
        <div className="border border-border rounded-md p-4 bg-muted/10 animate-pulse">
          <div className="h-5 w-32 bg-muted rounded mb-2" />
          <div className="h-4 w-48 bg-muted rounded" />
        </div>
      </section>
    );
  }

  if (isError) {
    return (
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
          Connection
        </h2>
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load Jira connection status:{" "}
            {error instanceof Error ? error.message : "unknown error"}.
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  if (!data) return null;

  if (data.notConfigured) {
    return (
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
          Connection
        </h2>
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Jira integration isn't enabled on this server yet. Fill in{" "}
            <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">JIRA_CLIENT_ID</code>,{" "}
            <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
              JIRA_CLIENT_SECRET
            </code>
            , and{" "}
            <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">
              JIRA_WEBHOOK_TOKEN
            </code>{" "}
            below, save, and restart the API to enable OAuth.
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const expiryLabel = formatTokenExpiry(data.tokenExpiresAt);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
        Connection
      </h2>

      <div className="border border-border rounded-md bg-muted/10">
        {/* Status row */}
        <div className="flex items-start justify-between gap-4 p-4">
          <div className="flex items-start gap-3">
            <div
              className={
                data.connected
                  ? "mt-1.5 h-2 w-2 rounded-full bg-emerald-500 shrink-0"
                  : "mt-1.5 h-2 w-2 rounded-full bg-zinc-500 shrink-0"
              }
              aria-hidden="true"
            />
            <div className="space-y-1">
              <div className="text-sm font-medium">
                {data.connected ? "Connected to Jira" : "Not connected"}
              </div>
              {data.connected ? (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {data.siteUrl && (
                    <div>
                      Site:{" "}
                      <a
                        href={data.siteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono underline hover:text-foreground"
                      >
                        {data.siteUrl}
                      </a>
                    </div>
                  )}
                  {data.cloudId && (
                    <div>
                      cloudId: <span className="font-mono">{data.cloudId}</span>
                    </div>
                  )}
                  {data.scope && (
                    <div>
                      Scope: <span className="font-mono">{data.scope}</span>
                    </div>
                  )}
                  {expiryLabel && <div>Token expires: {expiryLabel}</div>}
                  <div>
                    Registered webhooks: <span className="font-mono">{data.webhookIds.length}</span>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  Click Connect to authorize a Jira Cloud workspace via OAuth 3LO.
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {data.connected ? (
              <Button type="button" size="sm" variant="outline" onClick={handleAuthorize}>
                <RefreshCw className="h-3.5 w-3.5" />
                Re-authenticate
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={handleAuthorize}>
                <LinkIcon className="h-3.5 w-3.5" />
                Connect to Jira
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Webhook URL row */}
        {data.webhookUrl && (
          <div className="border-t border-border px-4 py-3 space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Webhook URL
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-xs bg-muted px-2 py-1 rounded truncate">
                {data.webhookUrl}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleCopyWebhook}
                className="shrink-0"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {data.connected && !data.hasManageWebhookScope ? (
              <p className="text-xs text-muted-foreground">
                Your OAuth grant lacks the <span className="font-mono">manage:jira-webhook</span>{" "}
                scope. Register this URL manually in Atlassian's webhook UI, or reconnect with the
                scope to enable auto-registration.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                The swarm auto-registers webhooks via <span className="font-mono">POST</span>{" "}
                <span className="font-mono">/api/trackers/jira/webhook-register</span> with a JQL
                filter. Treat this URL like a Slack incoming-webhook URL — keep it private.
              </p>
            )}
          </div>
        )}

        {/* Footer / refresh + disconnect note */}
        <div className="border-t border-border px-4 py-3 flex items-center justify-between gap-3">
          <p className="text-xs italic text-muted-foreground">
            Disconnect not available — revoke access in your Atlassian account settings.
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={isFetching ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
            Refresh
          </Button>
        </div>
      </div>
    </section>
  );
}
