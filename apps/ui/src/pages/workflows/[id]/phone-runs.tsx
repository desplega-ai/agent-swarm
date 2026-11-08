import type { WorkflowRunSummary } from "@/api/types";
import { MobileList, MobileListRow } from "@/components/shared/mobile-list";
import { StatusBadge } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { isAutomationSetupError } from "@/lib/automation-setup";
import { formatElapsed, formatSmartTime } from "@/lib/utils";

/**
 * Runs tab rows for a phone. The desktop grid squeezes four columns into 340px
 * (status chip cut to "WAITIN", error clipped to six characters); a row shows
 * the start time, the status chip, then duration and the error on the meta line.
 */
export function PhoneRunsList({ runs, loading }: { runs: WorkflowRunSummary[]; loading: boolean }) {
  return (
    <MobileList label="Workflow runs" loading={loading} emptyMessage="No runs yet">
      {runs.map((run) => (
        <MobileListRow
          key={run.id}
          to={`/workflow-runs/${run.id}`}
          title={formatSmartTime(run.startedAt)}
          titleLines={1}
          status={
            isAutomationSetupError(run.error) ? (
              <Badge
                variant="outline"
                size="tag"
                className="border-status-pending/30 text-status-pending-strong"
              >
                Needs setup
              </Badge>
            ) : (
              <StatusBadge status={run.status} />
            )
          }
          meta={[
            run.finishedAt ? formatElapsed(run.startedAt, run.finishedAt) : null,
            run.error ? (
              <span key="error" className="text-status-error-strong">
                {run.error}
              </span>
            ) : null,
          ]}
        />
      ))}
    </MobileList>
  );
}
