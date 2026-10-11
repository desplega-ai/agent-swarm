import { Boxes, Server } from "lucide-react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import type { RuntimePool } from "@/api/types";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { SectionTabs } from "@/components/shared/section-tabs";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isCircuitOpen, useRuntimePoolsGate } from "@/lib/runtime-pools";
import { formatSmartTime } from "@/lib/utils";

export const RUNTIME_POOLS_PATH = "/settings/runtime-pools";
export const RUNTIME_CONTROLLERS_PATH = "/settings/runtime-pools/controllers";

/**
 * Renders the runtime pool pages only while the gate is open. A closed gate
 * (old API, or `RUNTIME_POOLS_ENABLED` off) sends the reader to `/settings`.
 */
export function RuntimePoolsGuard({ children }: { children: ReactNode }) {
  const gate = useRuntimePoolsGate();
  if (gate.loading) return <PageSkeleton />;
  if (!gate.open) return <Navigate to="/settings" replace />;
  return children;
}

/** Pools and Controllers subnav, shown above both list pages. */
export function RuntimePoolsTabs() {
  const location = useLocation();
  return (
    <SectionTabs
      label="Runtime pools"
      tabs={[
        { title: "Pools", path: RUNTIME_POOLS_PATH, icon: Boxes, end: true },
        { title: "Controllers", path: RUNTIME_CONTROLLERS_PATH, icon: Server },
      ]}
      activePath={location.pathname}
      className="shrink-0"
    />
  );
}

/** Pool health as one chip: circuit open, last error, or healthy. */
export function PoolHealthBadge({
  pool,
}: {
  pool: Pick<RuntimePool, "circuitOpenUntil" | "lastError" | "lastErrorAt" | "consecutiveFailures">;
}) {
  if (isCircuitOpen(pool)) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            size="tag"
            className="border-status-error/30 text-status-error-strong"
          >
            Circuit open
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-80">
          Provisioning paused until {formatSmartTime(pool.circuitOpenUntil as string)}.
          {pool.lastError ? ` Last error: ${pool.lastError}` : ""}
        </TooltipContent>
      </Tooltip>
    );
  }
  if (pool.lastError && pool.consecutiveFailures > 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            size="tag"
            className="border-status-warning/30 text-status-warning-strong"
          >
            {pool.consecutiveFailures} failed
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-80">{pool.lastError}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Badge
      variant="outline"
      size="tag"
      className="border-status-success/30 text-status-success-strong"
    >
      Healthy
    </Badge>
  );
}
