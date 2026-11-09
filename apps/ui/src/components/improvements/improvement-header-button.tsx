import { Lightbulb, Plus } from "lucide-react";
import { useState } from "react";
import { useImprovements } from "@/api/hooks/use-improvements";
import type { Improvement } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCan } from "@/lib/use-can";
import { ImprovementApprovalList, isActionableImprovement } from "./improvement-approval-list";
import { ImprovementDialog } from "./improvement-dialog";

/**
 * Header door to improvements: a popover with the drafts waiting for a
 * person (approve or discard) and a "New improvement" entry that opens the
 * dialog. Hidden while `IMPROVEMENTS_ENABLED` is off (or on an API without
 * the route). A dot shows while drafts wait.
 */
export function ImprovementHeaderButton() {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data } = useImprovements();
  const canApprove = useCan("improvement.approve");
  if (!data?.enabled) return null;
  const waiting = data.improvements.filter(isActionableImprovement);

  return (
    <>
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="relative size-8"
                aria-label={
                  waiting.length > 0
                    ? `Improvements, ${waiting.length} waiting for approval`
                    : "Improvements"
                }
              >
                <Lightbulb className="size-4" />
                {waiting.length > 0 ? (
                  <span
                    className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-status-warning"
                    aria-hidden="true"
                  />
                ) : null}
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Improvements</TooltipContent>
        </Tooltip>
        <PopoverContent
          align="end"
          aria-label="Improvements"
          className="max-h-(--radix-popover-content-available-height) w-96 max-w-[calc(100vw-1rem)] space-y-3 overflow-y-auto"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Improvements</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPopoverOpen(false);
                setDialogOpen(true);
              }}
            >
              <Plus className="size-3.5" />
              New improvement
            </Button>
          </div>
          <ImprovementApprovalList rows={waiting} canApprove={canApprove} />
        </PopoverContent>
      </Popover>
      <ImprovementDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}

/** The drafts waiting for a person, or `null` while improvements are off. */
export function useWaitingImprovements(): Improvement[] | null {
  const { data } = useImprovements();
  if (!data?.enabled) return null;
  return data.improvements.filter(isActionableImprovement);
}
