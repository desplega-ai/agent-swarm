import { AlertCircle, Check, Copy, Terminal } from "lucide-react";
import { useConfigs } from "@/api/hooks/use-config-api";
import { CodexAccountsList } from "@/components/onboarding/codex-accounts-list";
import { OAuthSection, OAuthSectionRow, OAuthStatusRow } from "@/components/shared/oauth-section";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { getConfig } from "@/lib/config";

// ---------------------------------------------------------------------------
// Codex ChatGPT OAuth section. The sign-in runs on the user's laptop, not in
// the browser. We surface:
//   1. An explainer
//   2. A copyable `codex-login` snippet auto-filled with the current API URL
//   3. Status derived from the global `codex_oauth` / `codex_oauth_<n>` rows
//   4. The stored ChatGPT accounts, each with Remove (`CodexAccountsList`)
// ---------------------------------------------------------------------------

/** Global rows the CLI and the device flow write (`codex_oauth` is the legacy slot 0). */
const CODEX_SLOT_KEY = /^codex_oauth(_\d+)?$/i;

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

  const { copied, copy } = useCopyToClipboard();

  const isConfigured = !!configs?.some((c) => c.scope === "global" && CODEX_SLOT_KEY.test(c.key));

  const handleCopy = () => copy(snippet);

  return (
    <div className="space-y-6">
      {/* Explainer */}
      <Alert>
        <Terminal className="h-4 w-4" />
        <AlertDescription>
          Run the command below on your laptop. The CLI walks you through the browser consent flow,
          then uploads the credentials to this swarm's encrypted config store. Each sign-in adds one
          ChatGPT account.
        </AlertDescription>
      </Alert>

      {/* Command snippet */}
      <OAuthSection title="CLI command">
        <div className="p-4 space-y-2">
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
                <Check className="h-3.5 w-3.5 text-status-success-strong" />
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
        </div>
      </OAuthSection>

      {/* Status */}
      <OAuthSection title="Status">
        {isLoading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading status…</div>
        ) : (
          <OAuthStatusRow
            connected={isConfigured}
            label={isConfigured ? "OAuth is configured" : "Not configured"}
            description={
              isConfigured ? (
                <>
                  Codex workers will restore these credentials into{" "}
                  <code className="font-mono">~/.codex/auth.json</code> on boot.
                </>
              ) : (
                "Run the command above from your laptop to store Codex OAuth credentials."
              )
            }
          />
        )}
        <OAuthSectionRow>
          <CodexAccountsList />
        </OAuthSectionRow>
      </OAuthSection>

      {/* Non-ideal edge: if we can't list configs at all, warn. */}
      {!isLoading && !configs && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Unable to read global config. Check your API connection in the sidebar.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
