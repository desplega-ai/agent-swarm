import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useTestConnection } from "@/api/hooks/use-status";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useLeadCredentialIssue } from "@/hooks/use-lead-credential-issue";
import { CONFIGURATION_KEYS } from "@/lib/configuration-catalog";
import { cn } from "@/lib/utils";

const CREDENTIAL_DOCS_URL = "https://docs.agent-swarm.dev/docs/guides/harness-configuration";

export function LeadCredentialDialog() {
  const { state: currentUserState } = useCurrentUser();
  const { issue, refetch } = useLeadCredentialIssue();
  const testConnection = useTestConnection();
  const [dismissed, setDismissed] = useState(false);

  if (!issue) return null;

  const configurationKey = issue.missing.find((key) => CONFIGURATION_KEYS.includes(key));
  const configurationPath = configurationKey
    ? `/settings/configuration?search=${encodeURIComponent(configurationKey)}#setting-${encodeURIComponent(configurationKey)}`
    : `/agents/${issue.agentId}?tab=credentials`;
  const canRecheck = issue.provider !== null;
  const testResult = testConnection.data;
  const testError = testConnection.error;

  function handleRecheck() {
    if (!issue?.provider) return;
    testConnection.mutate(issue.provider, {
      onSettled: () => void refetch(),
    });
  }

  return (
    <Dialog
      open={!dismissed && currentUserState !== "needs-pick"}
      onOpenChange={(open) => {
        if (!open) setDismissed(true);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-2 text-status-error-strong">
            <AlertTriangle className="size-5" aria-hidden="true" />
            <DialogTitle>Lead agent needs credentials</DialogTitle>
          </div>
          <DialogDescription>
            {issue.agentName} cannot start tasks until its {issue.provider ?? "LLM"} credentials are
            available.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          {issue.missing.length > 0 && (
            <div className="rounded-md border border-status-error/30 bg-status-error/5 p-3">
              <p className="text-xs font-medium text-muted-foreground">Missing</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {issue.missing.map((key) => (
                  <code key={key} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                    {key}
                  </code>
                ))}
              </div>
            </div>
          )}
          {issue.hint && <p className="text-muted-foreground">{issue.hint}</p>}
          {(testResult || testError) && (
            <output
              className={cn(
                "text-xs",
                testResult?.ok ? "text-status-success-strong" : "text-status-error-strong",
              )}
            >
              {testError instanceof Error
                ? testError.message
                : testResult?.ok
                  ? "Credential check passed. The lead will become available shortly."
                  : testResult?.error || "Credentials are still unavailable."}
            </output>
          )}
          <a
            href={CREDENTIAL_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            Credential setup guide
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </div>

        <DialogFooter>
          {canRecheck && (
            <Button
              type="button"
              variant="outline"
              onClick={handleRecheck}
              disabled={testConnection.isPending}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {testConnection.isPending ? "Checking…" : "Re-check"}
            </Button>
          )}
          <Button asChild onClick={() => setDismissed(true)}>
            <Link to={configurationPath}>
              {configurationKey ? "Open configuration" : "View credential details"}
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
