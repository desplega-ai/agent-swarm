import { Lightbulb } from "lucide-react";
import { useState } from "react";
import { useImprovements } from "@/api/hooks/use-improvements";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ImprovementDialog } from "./improvement-dialog";

/**
 * Header door to the improvement dialog. Hidden while `IMPROVEMENTS_ENABLED`
 * is off (or on an API without the route). A dot shows while drafts wait for
 * a person's approval.
 */
export function ImprovementHeaderButton() {
  const [open, setOpen] = useState(false);
  const { data } = useImprovements();
  if (!data?.enabled) return null;
  const pending = data.improvements.filter((row) => row.status === "pending_approval").length;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative size-8"
            onClick={() => setOpen(true)}
            aria-label="Suggest an improvement"
          >
            <Lightbulb className="size-4" />
            {pending > 0 ? (
              <span
                className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-status-warning"
                aria-hidden="true"
              />
            ) : null}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {pending > 0
            ? `Suggest an improvement (${pending} waiting for approval in Settings)`
            : "Suggest an improvement"}
        </TooltipContent>
      </Tooltip>
      <ImprovementDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
