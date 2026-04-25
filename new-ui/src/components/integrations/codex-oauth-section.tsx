import { AlertCircle, Check, Copy, Terminal, Trash2 } from "lucide-react";
import { useState } from "react";
import { useConfigs, useDeleteConfigsBatch } from "@/api/hooks/use-config-api";
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
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { getConfig } from "@/lib/config";

// ---------------------------------------------------------------------------
// Codex ChatGPT OAuth section — the entire flow happens on the user's laptop,
// not the browser. We surface:
//   1. An explainer
//   2. A copyable `codex-login` snippet auto-filled with the current API URL
//   3. Status derived from presence of the `codex_oauth` global config row
//   4. A "Clear stored OAuth" button (confirm dialog) that deletes that row
// ---------------------------------------------------------------------------

const CODEX_OAUTH_KEY = "codex_oauth";

function resolveApiUrl(): string {
  // Prefer the configured API URL so the snippet works in multi-connection setups.
  const config = getConfig();
  if (config.apiUrl && config.apiUrl.trim().length > 0) return config.apiUrl;
  // Fallback: current origin (useful when served behind a reverse proxy).
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "http://localhost:3013";
}

export function CodexOAuthSection() {
  const apiUrl = resolveApiUrl();
  const snippet = `npx @desplega.ai/agent-swarm codex-login --api-url ${apiUrl}`;

  const { data: configs, isLoading } = useConfigs({ scope: "global" });
  const deleteBatch = useDeleteConfigsBatch();

  const [copied, setCopied] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);

  const codexRow = configs?.find((c) => c.key === CODEX_OAUTH_KEY && c.scope === "global");
  const isConfigured = !!codexRow;

  async function handleCopy() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(snippet);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // Clipboard unavailable — silent.
    }
  }

  function handleClear() {
    if (!configs) return;
    deleteBatch.mutate({ configs, keys: [CODEX_OAUTH_KEY] });
    setConfirmClearOpen(false);
  }

  return (
    <div className="space-y-6">
      {/* Explainer */}
      <Alert>
        <Terminal className="h-4 w-4" />
        <AlertDescription>
          Codex ChatGPT OAuth must be completed from your local terminal — it cannot be done from
          this UI. Run the command below on your laptop; the CLI walks you through the browser
          consent flow and then uploads the resulting credentials to this swarm's encrypted config
          store.
        </AlertDescription>
      </Alert>

      {/* Command snippet */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
          CLI command
        </h2>
        <div className="flex items-start gap-2">
          <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded border border-border break-all">
            {snippet}
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleCopy}
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
        <p className="text-xs text-muted-foreground">
          The <code className="font-mono">--api-url</code> flag is auto-filled from your active
          connection.
        </p>
      </section>

      {/* Status */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
          Status
        </h2>
        <div className="border border-border rounded-md bg-muted/10 p-4 flex items-start justify-between gap-4">
          {isLoading ? (
            <div className="text-sm text-muted-foreground">Loading status…</div>
          ) : isConfigured ? (
            <div className="flex items-start gap-3">
              <div className="mt-1.5 h-2 w-2 rounded-full bg-emerald-500 shrink-0" aria-hidden />
              <div className="space-y-1">
                <div className="text-sm font-medium">OAuth is configured</div>
                <div className="text-xs text-muted-foreground">
                  Codex workers will restore these credentials into{" "}
                  <code className="font-mono">~/.codex/auth.json</code> on boot.
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3">
              <div className="mt-1.5 h-2 w-2 rounded-full bg-zinc-500 shrink-0" aria-hidden />
              <div className="space-y-1">
                <div className="text-sm font-medium">Not configured</div>
                <div className="text-xs text-muted-foreground">
                  Run the command above from your laptop to store Codex OAuth credentials.
                </div>
              </div>
            </div>
          )}

          {isConfigured && (
            <Button
              type="button"
              size="sm"
              variant="destructive-outline"
              className="shrink-0 hover:text-red-300"
              onClick={() => setConfirmClearOpen(true)}
              disabled={deleteBatch.isPending}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear stored OAuth
            </Button>
          )}
        </div>
      </section>

      {/* Non-ideal edge: if we can't list configs at all, warn. */}
      {!isLoading && !configs && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Unable to read global config. Check your API connection in the sidebar.
          </AlertDescription>
        </Alert>
      )}

      {/* Confirm clear dialog */}
      <AlertDialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear stored Codex OAuth?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the <code className="font-mono">codex_oauth</code> row from the global
              config. Codex workers will lose ChatGPT-based access until you re-run{" "}
              <code className="font-mono">codex-login</code> from your laptop.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleClear}>
              Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
