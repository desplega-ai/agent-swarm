import { PlugZap } from "lucide-react";
import { useState } from "react";
import {
  type GoogleDriveTestResult,
  useTestGoogleDriveConnection,
} from "@/api/hooks/use-integrations-meta";
import type { SwarmConfig } from "@/api/types";
import { OAuthSection } from "@/components/shared/oauth-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { IntegrationDef } from "@/lib/integrations-catalog";
import { deriveIntegrationStatus, type EnvPresence } from "@/lib/integrations-status";

interface GoogleDriveSectionProps {
  def: IntegrationDef;
  configs: SwarmConfig[];
  envPresence: EnvPresence;
}

export function GoogleDriveSection({ def, configs, envPresence }: GoogleDriveSectionProps) {
  const status = deriveIntegrationStatus(def, configs, envPresence);
  const testConnection = useTestGoogleDriveConnection();
  const [lastResult, setLastResult] = useState<GoogleDriveTestResult | null>(null);

  async function handleTest() {
    try {
      const result = await testConnection.mutateAsync();
      setLastResult(result);
    } catch {
      setLastResult({ ok: false, error: "Request failed" });
    }
  }

  const statusBadge =
    status === "configured" ? (
      <Badge variant="outline" size="tag" className="border-status-success/30 text-status-success">
        Configured
      </Badge>
    ) : status === "partial" ? (
      <Badge variant="outline" size="tag" className="border-status-active/30 text-status-active">
        Partial
      </Badge>
    ) : (
      <Badge variant="outline" size="tag" className="border-status-neutral/30 text-status-neutral">
        Not configured
      </Badge>
    );

  return (
    <OAuthSection title="Connection">
      <div className="p-4 space-y-3">
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
                <div className="mt-1 h-2 w-2 rounded-full bg-status-success shrink-0" aria-hidden />
                <div className="space-y-0.5">
                  <div className="font-medium text-status-success">
                    Service account authenticated
                  </div>
                  <div className="text-muted-foreground">
                    SA: <code className="font-mono">{lastResult.clientEmail}</code>
                    {lastResult.projectId && (
                      <>
                        {" · "}Project: <code className="font-mono">{lastResult.projectId}</code>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <div className="mt-1 h-2 w-2 rounded-full bg-status-error shrink-0" aria-hidden />
                <div className="space-y-0.5">
                  <div className="font-medium text-status-error">Connection failed</div>
                  <div className="text-muted-foreground break-words">
                    {lastResult.error ?? "Unknown error"}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </OAuthSection>
  );
}
