import { Check, Copy, PlugZap, Terminal } from "lucide-react";
import { useState } from "react";
import { useTestClaudeManagedConnection } from "@/api/hooks/use-integrations-meta";
import type { SwarmConfig } from "@/api/types";
import { OAuthSection } from "@/components/shared/oauth-section";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { getIntegrationFields, type IntegrationDef } from "@/lib/integrations-catalog";
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
//   3. A presence pill driven by `deriveIntegrationStatus` against the
//      catalog's required fields (ANTHROPIC_API_KEY, MANAGED_AGENT_ID,
//      MANAGED_ENVIRONMENT_ID, MCP_BASE_URL). It says "Configured", never
//      "Connected": only a passing test for the current values earns that.
//
// Unlike `codex-oauth`, the catalog DOES expose editable fields — so the
// generic form still renders BELOW this section. This component only adds the
// CLI explainer + test-connection affordance on top.
// ---------------------------------------------------------------------------

interface ClaudeManagedSectionProps {
  def: IntegrationDef;
  configs: SwarmConfig[];
  envPresence: EnvPresence;
  /** `dataUpdatedAt` of the env-presence query; bumps on every response. */
  envPresenceRevision?: number;
}

const SETUP_SNIPPET = "bunx @desplega.ai/agent-swarm claude-managed-setup";

interface TestResult {
  ok: boolean;
  agentName?: string | null;
  model?: string | null;
  error?: string;
}

// Each env-presence object gets an id, so a caller that hands over a new
// snapshot retires results even when the booleans are equal.
const envSnapshotIds = new WeakMap<EnvPresence, number>();
let nextEnvSnapshotId = 0;
function envSnapshotId(envPresence: EnvPresence): number {
  let id = envSnapshotIds.get(envPresence);
  if (id === undefined) {
    id = ++nextEnvSnapshotId;
    envSnapshotIds.set(envPresence, id);
  }
  return id;
}

/**
 * Identifies the config a test ran against: the update time of every row the
 * test endpoint resolves for a required key (it accepts the key, lowercase and
 * uppercase; the setup CLI writes lowercase). Env-backed values are invisible
 * here, only their presence is, so any fresh env-presence response makes an
 * earlier result stale.
 */
export function claudeManagedFingerprint(
  def: IntegrationDef,
  configs: SwarmConfig[],
  envPresence: EnvPresence,
  envPresenceRevision = 0,
): string {
  let envBacked = false;
  const parts = getIntegrationFields(def)
    .filter((field) => field.required)
    .map((field) => {
      const variants = new Set([field.key, field.key.toLowerCase(), field.key.toUpperCase()]);
      const rows = configs.filter((c) => c.scope === "global" && variants.has(c.key));
      const fromRows = rows.map((c) => `${c.key}@${c.lastUpdatedAt}`).join(",");
      const fromEnv = !rows.some((c) => c.value.length > 0) && envPresence[field.key] === true;
      if (fromEnv) envBacked = true;
      return `${field.key}=${fromRows}${fromEnv ? "env" : ""}`;
    });
  if (envBacked) parts.push(`env@${envPresenceRevision}#${envSnapshotId(envPresence)}`);
  return parts.join("|");
}

export function ClaudeManagedSection({
  def,
  configs,
  envPresence,
  envPresenceRevision,
}: ClaudeManagedSectionProps) {
  const status = deriveIntegrationStatus(def, configs, envPresence);
  const testConnection = useTestClaudeManagedConnection();

  const { copied, copy } = useCopyToClipboard();
  const [tested, setTested] = useState<{
    fingerprint: string;
    testedAt: Date;
    result: TestResult;
  } | null>(null);
  const fingerprint = claudeManagedFingerprint(def, configs, envPresence, envPresenceRevision);
  // A result for values that may have changed says nothing about the current
  // ones: it loses its badge and shows as history.
  const lastResult = tested?.fingerprint === fingerprint ? tested.result : null;
  const staleResult = tested && !lastResult ? tested : null;

  const handleCopy = () => copy(SETUP_SNIPPET);

  async function handleTest() {
    // Pin the values the request was sent with, not the ones it returns to.
    const testedFingerprint = fingerprint;
    try {
      const result = await testConnection.mutateAsync();
      setTested({ fingerprint: testedFingerprint, testedAt: new Date(), result });
    } catch {
      // mutation hook surfaces its own error toast
      setTested({
        fingerprint: testedFingerprint,
        testedAt: new Date(),
        result: { ok: false, error: "Request failed" },
      });
    }
  }

  const testBadge = lastResult ? (
    lastResult.ok ? (
      <Badge
        variant="outline"
        size="tag"
        className="border-status-success/30 text-status-success-strong"
      >
        Connected
      </Badge>
    ) : (
      <Badge
        variant="outline"
        size="tag"
        className="border-status-error/30 text-status-error-strong"
      >
        Test failed
      </Badge>
    )
  ) : null;

  const statusBadge =
    status === "configured" ? (
      <Badge variant="outline" size="tag" className="border-status-info/30 text-status-info-strong">
        Configured
      </Badge>
    ) : status === "partial" ? (
      <Badge
        variant="outline"
        size="tag"
        className="border-status-active/30 text-status-active-strong"
      >
        Partial
      </Badge>
    ) : (
      <Badge
        variant="outline"
        size="tag"
        className="border-status-neutral/30 text-status-neutral-strong"
      >
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
          configured once the CLI completes. Test the connection to confirm it works.
        </AlertDescription>
      </Alert>

      {/* Command snippet */}
      <OAuthSection title="Setup CLI">
        <div className="p-4 flex items-start gap-2">
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
              <Check className="h-3.5 w-3.5 text-status-success-strong" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </OAuthSection>

      {/* Status + Test connection */}
      <OAuthSection title="Connection">
        <div className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Status:</span>
              {statusBadge}
              {testBadge}
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
                  <div
                    className="mt-1 h-2 w-2 rounded-full bg-status-success shrink-0"
                    aria-hidden
                  />
                  <div className="space-y-0.5">
                    <div className="font-medium text-status-success-strong">
                      Connected to managed agent
                    </div>
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
                  <div className="mt-1 h-2 w-2 rounded-full bg-status-error shrink-0" aria-hidden />
                  <div className="space-y-0.5">
                    <div className="font-medium text-status-error-strong">Connection failed</div>
                    <div className="text-muted-foreground break-words">
                      {lastResult.error ?? "Unknown error"}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {staleResult && (
            <div className="text-xs text-muted-foreground">
              Last test at {staleResult.testedAt.toLocaleTimeString()}:{" "}
              {staleResult.result.ok ? "passed" : "failed"}. The config may have changed since; test
              again to confirm.
            </div>
          )}
        </div>
      </OAuthSection>
    </div>
  );
}
