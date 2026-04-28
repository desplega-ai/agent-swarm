import { Check, Copy, PlugZap, Terminal } from "lucide-react";
import { useState } from "react";
import { useTestClaudeManagedConnection } from "@/api/hooks/use-integrations-meta";
import type { SwarmConfig } from "@/api/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { IntegrationDef } from "@/lib/integrations-catalog";
import { deriveIntegrationStatus, type EnvPresence } from "@/lib/integrations-status";

// ---------------------------------------------------------------------------
// Claude Managed Agents — special-flow section
//
// Mirrors `CodexOAuthSection` but for the claude-managed provider. The agent
// + environment IDs are created by a one-shot CLI (`claude-managed-setup`),
// then this UI surfaces:
//   1. An explainer + copyable CLI snippet
//   2. A "Test connection" button that hits
//      POST /api/integrations/claude-managed/test (calls beta.agents.retrieve)
//   3. A connection status pill driven by `deriveIntegrationStatus` against the
//      catalog's required fields (ANTHROPIC_API_KEY, MANAGED_AGENT_ID,
//      MANAGED_ENVIRONMENT_ID, MCP_BASE_URL).
//
// Unlike `codex-oauth`, the catalog DOES expose editable fields — so the
// generic form still renders BELOW this section. This component only adds the
// CLI explainer + test-connection affordance on top.
// ---------------------------------------------------------------------------

interface ClaudeManagedSectionProps {
  def: IntegrationDef;
  configs: SwarmConfig[];
  envPresence: EnvPresence;
}

const SETUP_SNIPPET = "bunx @desplega.ai/agent-swarm claude-managed-setup";

export function ClaudeManagedSection({ def, configs, envPresence }: ClaudeManagedSectionProps) {
  const status = deriveIntegrationStatus(def, configs, envPresence);
  const testConnection = useTestClaudeManagedConnection();

  const [copied, setCopied] = useState(false);
  const [lastResult, setLastResult] = useState<{
    ok: boolean;
    agentName?: string | null;
    model?: string | null;
    error?: string;
  } | null>(null);

  async function handleCopy() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(SETUP_SNIPPET);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      // Clipboard unavailable — silent.
    }
  }

  async function handleTest() {
    try {
      const result = await testConnection.mutateAsync();
      setLastResult(result);
    } catch {
      // mutation hook surfaces its own error toast
      setLastResult({ ok: false, error: "Request failed" });
    }
  }

  const statusBadge =
    status === "configured" ? (
      <Badge variant="outline" size="tag" className="border-emerald-500/30 text-emerald-400">
        Connected
      </Badge>
    ) : status === "partial" ? (
      <Badge variant="outline" size="tag" className="border-amber-500/30 text-amber-400">
        Partial
      </Badge>
    ) : (
      <Badge variant="outline" size="tag" className="border-zinc-500/30 text-zinc-400">
        Not configured
      </Badge>
    );

  return (
    <div className="space-y-6">
      <Alert>
        <Terminal className="h-4 w-4" />
        <AlertDescription>
          Run{" "}
          <code className="font-mono text-xs bg-muted px-1 py-0.5 rounded">{SETUP_SNIPPET}</code>{" "}
          once to create the managed agent + environment. The CLI writes the IDs to{" "}
          <code className="font-mono">swarm_config</code>; this page will show the connection as
          connected once the CLI completes.
        </AlertDescription>
      </Alert>

      {/* Command snippet */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
          Setup CLI
        </h2>
        <div className="flex items-start gap-2">
          <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded border border-border break-all">
            {SETUP_SNIPPET}
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
      </section>

      {/* Status + Test connection */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
          Connection
        </h2>
        <div className="border border-border rounded-md bg-muted/10 p-4 space-y-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Status:</span>
              {statusBadge}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleTest}
              disabled={testConnection.isPending}
              className="shrink-0 gap-1.5"
            >
              <PlugZap className="h-3.5 w-3.5" />
              {testConnection.isPending ? "Testing…" : "Test connection"}
            </Button>
          </div>

          {lastResult && (
            <div className="text-xs">
              {lastResult.ok ? (
                <div className="flex items-start gap-2">
                  <div className="mt-1 h-2 w-2 rounded-full bg-emerald-500 shrink-0" aria-hidden />
                  <div className="space-y-0.5">
                    <div className="font-medium text-emerald-400">Connected to managed agent</div>
                    <div className="text-muted-foreground">
                      Name: <code className="font-mono">{lastResult.agentName ?? "(unnamed)"}</code>
                      {lastResult.model && (
                        <>
                          {" · "}Model: <code className="font-mono">{lastResult.model}</code>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <div className="mt-1 h-2 w-2 rounded-full bg-red-500 shrink-0" aria-hidden />
                  <div className="space-y-0.5">
                    <div className="font-medium text-red-400">Connection failed</div>
                    <div className="text-muted-foreground break-words">
                      {lastResult.error ?? "Unknown error"}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
