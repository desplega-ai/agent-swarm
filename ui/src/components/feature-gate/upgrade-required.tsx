/**
 * Generic "API server too old" page used by feature-gated routes (Sessions in
 * Phase 4; future surfaces in later phases).
 *
 * Render this when `useFeatureGate(<minVersion>).supported === false`.
 * The page is intentionally informational + non-blocking — no hard kill switch
 * (per the plan's soft-degrade contract).
 */

import { ArrowUpCircle, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

export interface UpgradeRequiredProps {
  /** User-visible name of the gated feature, e.g. "Sessions". */
  feature: string;
  /** Minimum API version that exposes the feature, e.g. "1.76.0". */
  requiredVersion: string;
  /** Currently-detected API version (from `useApiVersion()`). `null` while loading. */
  currentVersion: string | null;
  /** Optional override for the upgrade docs URL. Defaults to docs.agent-swarm.dev. */
  docsUrl?: string;
}

const DEFAULT_DOCS_URL = "https://docs.agent-swarm.dev/upgrade";

export function UpgradeRequired({
  feature,
  requiredVersion,
  currentVersion,
  docsUrl = DEFAULT_DOCS_URL,
}: UpgradeRequiredProps) {
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-4 p-1">
      <PageHeader title={feature} icon={ArrowUpCircle} />
      <Card className="max-w-xl">
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-foreground font-medium">Upgrade required</p>
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">{feature}</span> requires API{" "}
            <span className="font-mono">≥ {requiredVersion}</span>. This swarm is currently running{" "}
            {currentVersion ? (
              <span className="font-mono">v{currentVersion}</span>
            ) : (
              <span className="italic">an unknown version</span>
            )}
            .
          </p>
          <p className="text-muted-foreground">
            Other parts of the dashboard remain available — only {feature.toLowerCase()} is gated.
          </p>
          <a
            href={docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-primary hover:underline w-fit"
          >
            Upgrade docs
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
