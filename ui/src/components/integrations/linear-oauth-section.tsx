import {
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Link as LinkIcon,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  buildLinearAuthorizeUrl,
  useDisconnectLinear,
  useLinearTrackerStatus,
} from "@/api/hooks/use-linear-status";
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
// Linear OAuth connection card — renders above the generic field form.
// Backend shape: see src/http/trackers/linear.ts handleLinearTracker.
// ---------------------------------------------------------------------------

function formatTokenExpiry(expiry: number | null): string | null {
  if (!expiry) return null;
  // expiry is what `oauth_tokens.expiresAt` stores. Treat values below ~10^12
  // as unix seconds and scale up; larger values are already ms.
  const ms = expiry < 1e12 ? expiry * 1000 : expiry;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

type CopyKey = "webhook" | "redirect";

export function LinearOAuthSection() {
  const { data, isLoading, isError, error, refetch, isFetching } = useLinearTrackerStatus();
  const disconnect = useDisconnectLinear();
  const { copiedKey, copy } = useCopyToClipboard<CopyKey>();
  const handleCopy = (key: CopyKey, value: string) => copy(value, key);

  function handleAuthorize() {
    window.open(buildLinearAuthorizeUrl(), "_blank", "noopener,noreferrer");
  }

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
              Failed to load Linear connection status:{" "}
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
              Linear integration isn't enabled on this server yet. Fill in{" "}
              <CodeChip>LINEAR_CLIENT_ID</CodeChip>, <CodeChip>LINEAR_CLIENT_SECRET</CodeChip>, and{" "}
              <CodeChip>LINEAR_SIGNING_SECRET</CodeChip> below, save, and restart the API to enable
              OAuth.
            </p>
          </AlertDescription>
        </Alert>
      </section>
    );
  }

  const expiryLabel = formatTokenExpiry(data.tokenExpiry);

  return (
    <OAuthSection title="Connection">
      <OAuthStatusRow
        connected={data.connected}
        label={data.connected ? "Connected to Linear" : "Not connected"}
        description={
          data.connected ? (
            <div className="space-y-0.5">
              {data.scope && (
                <div>
                  Scope: <span className="font-mono">{data.scope}</span>
                </div>
              )}
              {expiryLabel && <div>Token expires: {expiryLabel}</div>}
            </div>
          ) : (
            "Click Connect to authorize a Linear workspace via OAuth."
          )
        }
        actions={
          data.connected ? (
            <Button type="button" size="sm" variant="outline" onClick={handleAuthorize}>
              <RefreshCw className="h-3.5 w-3.5" />
              Re-authenticate
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={handleAuthorize}>
              <LinkIcon className="h-3.5 w-3.5" />
              Connect to Linear
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )
        }
      />

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
            Paste this into your Linear OAuth app's Callback URLs — must match exactly.
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
          <p className="text-xs text-muted-foreground">
            Register this URL as a webhook in your Linear workspace to receive issue events.
          </p>
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
                <AlertDialogTitle>Disconnect Linear?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will revoke the OAuth grant with Linear (best effort) and drop stored
                  credentials. You'll need to reconnect to use Linear again.
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
