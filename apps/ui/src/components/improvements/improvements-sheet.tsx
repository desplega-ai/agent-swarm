import { Plus } from "lucide-react";
import { useState } from "react";
import { ActionSheet, ActionSheetItem } from "@/components/sessions-v2/mobile/action-sheet";
import { useCan } from "@/lib/use-can";
import { ImprovementApprovalList } from "./improvement-approval-list";
import { ImprovementDialog } from "./improvement-dialog";
import { useWaitingImprovements } from "./improvement-header-button";

/**
 * The phone form of the header popover, opened from the header menu: the
 * same "New improvement" entry and approval list, in a bottom sheet.
 */
export function ImprovementsSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const waiting = useWaitingImprovements() ?? [];
  const canApprove = useCan("improvement.approve");
  return (
    <>
      <ActionSheet open={open} onOpenChange={onOpenChange} title="Improvements">
        <ActionSheetItem icon={Plus} label="New improvement" onSelect={() => setDialogOpen(true)} />
        <div className="max-h-[60dvh] overflow-y-auto px-3 pt-1 pb-2">
          <ImprovementApprovalList rows={waiting} canApprove={canApprove} />
        </div>
      </ActionSheet>
      <ImprovementDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
