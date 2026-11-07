import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useConfigs } from "@/api/hooks/use-config-api";
import { useImprovements } from "@/api/hooks/use-improvements";
import {
  formatImprovementTime,
  IMPROVEMENT_STATUS_LABEL,
  IMPROVEMENT_STATUS_VARIANT,
  isActionableImprovement,
} from "@/components/improvements/improvement-approval-list";
import { Badge } from "@/components/ui/badge";

/**
 * Settings → Configuration → Telemetry: what improvements send and the send
 * history. The `IMPROVEMENTS_ENABLED` toggle above this section is a plain
 * catalog row. Drafts are approved, and new ones written, from the lightbulb
 * popover in the header.
 */
export function ImprovementsRow() {
  const { data, isError } = useImprovements();
  const queryClient = useQueryClient();
  const { data: configs } = useConfigs({ scope: "global" });
  const switchValue = configs?.find((config) => config.key === "IMPROVEMENTS_ENABLED")?.value;
  // The switch is a plain catalog row; refetch (and so hide or show the header
  // button) once its saved value changes.
  useEffect(() => {
    void switchValue;
    queryClient.invalidateQueries({ queryKey: ["improvements"] });
  }, [switchValue, queryClient]);

  if (isError || !data) return null;
  const waiting = data.improvements.filter(isActionableImprovement).length;
  const history = data.improvements.filter((row) => !isActionableImprovement(row));

  return (
    <div id="setting-improvements" className="scroll-mt-6 space-y-3 py-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Improvements</span>
          {!data.enabled ? (
            <Badge variant="secondary" size="tag">
              Off
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Product improvements for the Agent Swarm team. Agents can only draft them. A person
          approves each one from the lightbulb button in the header, and only its text, the
          approver's email and the install id are sent.
        </p>
      </div>
      {data.enabled ? (
        waiting > 0 ? (
          <p className="text-xs text-muted-foreground">
            {waiting === 1 ? "1 draft is" : `${waiting} drafts are`} waiting for approval in the
            header.
          </p>
        ) : null
      ) : (
        <p className="text-xs text-muted-foreground">
          Turned off. Nothing can be drafted or sent until Improvements is on.
        </p>
      )}
      {history.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium">History</p>
          <ul className="divide-y divide-border-subtle rounded-md border">
            {history.map((row) => (
              <li key={row.id} className="space-y-1 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <Badge variant={IMPROVEMENT_STATUS_VARIANT[row.status]} size="tag">
                    {IMPROVEMENT_STATUS_LABEL[row.status]}
                  </Badge>
                  <span>{row.requestedByAgentId ? "Agent draft" : "Person"}</span>
                  {row.approvedBy ? <span>Approved by {row.approvedBy}</span> : null}
                  <span>{formatImprovementTime(row.sentAt ?? row.updatedAt)}</span>
                  {row.proxyStatus ? <span>Proxy {row.proxyStatus}</span> : null}
                </div>
                <p className="line-clamp-2 whitespace-pre-wrap break-words text-sm">{row.text}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
