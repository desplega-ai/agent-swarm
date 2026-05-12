import { AlertCircle, Check, Copy, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import {
  buildJiraAuthorizeUrl,
  useDisconnectJira,
  useJiraTrackerStatus,
} from "@/api/hooks/use-jira-status";
import { OAuthSection, OAuthSectionRow, OAuthStatusRow } from "@/components/shared/oauth-section";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

// ---------------------------------------------------------------------------
// Jira OAuth connection card — renders above the generic field form.
//
// Backend shape: see src/http/trackers/jira.ts handleJiraTracker.
// ---------------------------------------------------------------------------

function formatTokenExpiry(expiry: string | null): string | null {
  if (!expiry) return null;
  const d = new Date(expiry);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

type CopyKey = "webhook" | "redirect" | "site" | "authorize";

export function JiraOAuthSection() {
  const { data, isLoading, isError, error, refetch, isFetching } = useJiraTrackerStatus();
  const disconnect = useDisconnectJira();
  const { copiedKey, copy } = useCopyToClipboard<CopyKey>();
  const handleCopy = (key: CopyKey, value: string) => copy(value, key);

  if (isLoading) {
    return (
      <OAuthSection title="Connection">
        <div className="p-4 animate-pulse">
          <div className="h-5 w-32 bg-muted rounded mb-2" />
          <div className="h-4 w-48 bg-muted rounded" />
        </div>
      </OAuthSection>
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
            <p>
              Failed to load Jira connection status:{" "}
              {error instanceof Error ? error.message : "unknown error"}.
            </p>
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
            <p>
              Jira integration isn't enabled on this server yet. Fill in{" "}
              <CodeChip>JIRA_CLIENT_ID</CodeChip>, <CodeChip>JIRA_CLIENT_SECRET</CodeChip>, and{" "}
              <CodeChip>JIRA_WEBHOOK_TOKEN</CodeChip> below, save, and restart the API to enable
              OAuth.
            </p>
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const expiryLabel = formatTokenExpiry(data.tokenExpiresAt);

  return (
    <OAuthSection title="Connection">
      <OAuthStatusRow
        connected={data.connected}
        label={data.connected ? "Connected to Jira" : "Not connected"}
        description={
          data.connected ? (
            <div className="space-y-0.5">
              {data.siteUrl && (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span>Site:</span>
                  <code className="font-mono bg-muted px-1.5 py-0.5 rounded">{data.siteUrl}</code>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-5 w-5"
                    onClick={() => handleCopy("site", data.siteUrl ?? "")}
                    aria-label="Copy site URL"
                  >
                    {copiedKey === "site" ? (
                      <Check className="h-3 w-3 text-status-success" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </Button>
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
            "Copy the Authorization URL below and open it in a browser to authorize a Jira Cloud workspace via OAuth 3LO."
          )
        }
      />

      {/* Authorization URL row — copy instead of auto-redirect. */}
      <OAuthSectionRow>
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {data.connected ? "Re-authentication URL" : "Authorization URL"}
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 font-mono text-xs bg-muted px-2 py-1 rounded truncate">
            {buildJiraAuthorizeUrl()}
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => handleCopy("authorize", buildJiraAuthorizeUrl())}
            className="shrink-0"
          >
            {copiedKey === "authorize" ? (
              <Check className="h-3.5 w-3.5 text-status-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copiedKey === "authorize" ? "Copied" : "Copy"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => window.open(buildJiraAuthorizeUrl(), "_blank", "noopener,noreferrer")}
            className="shrink-0"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Open
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Open this URL in a browser to {data.connected ? "re-authenticate" : "authorize"} the swarm
          with Jira via OAuth 3LO.
        </p>
      </OAuthSectionRow>

      {/* Redirect URI row */}
      {data.redirectUri && (
        <OAuthSectionRow>
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Redirect URI
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs bg-muted px-2 py-1 rounded truncate">
              {data.redirectUri}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => handleCopy("redirect", data.redirectUri)}
              className="shrink-0"
            >
              {copiedKey === "redirect" ? (
                <Check className="h-3.5 w-3.5 text-status-success" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copiedKey === "redirect" ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Paste this into your Atlassian app's Authorization callback URL — must match exactly.
          </p>
        </OAuthSectionRow>
      )}

      {/* Webhook URL row */}
      {data.webhookUrl && (
        <OAuthSectionRow>
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
              onClick={() => handleCopy("webhook", data.webhookUrl)}
              className="shrink-0"
            >
              {copiedKey === "webhook" ? (
                <Check className="h-3.5 w-3.5 text-status-success" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              {copiedKey === "webhook" ? "Copied" : "Copy"}
            </Button>
          </div>
          {data.connected && !data.hasManageWebhookScope ? (
            <p className="text-xs text-muted-foreground">
              Your OAuth grant lacks the <CodeChip>manage:jira-webhook</CodeChip> scope. Register
              this URL manually in Atlassian's webhook UI, or reconnect with the scope to enable
              auto-registration.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              The swarm auto-registers webhooks via <CodeChip>POST</CodeChip>{" "}
              <CodeChip>/api/trackers/jira/webhook-register</CodeChip> with a JQL filter. Treat this
              URL like a Slack incoming-webhook URL — keep it private.
            </p>
          )}
        </OAuthSectionRow>
      )}

      {/* Footer / refresh + disconnect */}
      <OAuthSectionRow className="flex items-center justify-between gap-3 space-y-0">
        {data.connected ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="destructive-outline"
                disabled={disconnect.isPending}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect Jira?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will delete all {data.webhookIds.length} registered Atlassian webhook
                  {data.webhookIds.length === 1 ? "" : "s"}, drop stored OAuth credentials, and
                  clear cloudId / siteUrl metadata. You'll need to reconnect to use Jira again. To
                  fully revoke the OAuth grant, also remove the app at{" "}
                  <a
                    href="https://id.atlassian.com/manage/connected-apps"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    id.atlassian.com → Connected apps
                  </a>
                  .
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => disconnect.mutate()}>
                  Disconnect
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : (
          <span className="text-xs text-muted-foreground italic">Not connected.</span>
        )}
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
      </OAuthSectionRow>
    </OAuthSection>
  );
}

function CodeChip({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded whitespace-nowrap">
      {children}
    </code>
  );
}
