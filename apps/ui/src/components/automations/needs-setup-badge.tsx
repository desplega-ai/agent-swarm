import { Link } from "react-router-dom";
import type { StatusAutomation } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { automationFixText, automationMissingSummary } from "@/lib/automation-setup";

export {
  automationFixText,
  automationMissingItems,
  automationMissingSummary,
  automationPurpose,
  findAutomation,
} from "@/lib/automation-setup";

export function NeedsSetupBadge({ automation }: { automation?: StatusAutomation }) {
  if (!automation || automation.state !== "needs_setup") return null;
  const missing = automationMissingSummary(automation);
  const detailLabel = missing ? `Needs setup · ${missing}` : "Needs setup";
  const fixText = automationFixText(automation);

  return (
    <Badge
      asChild
      variant="outline"
      size="tag"
      className="max-w-full border-status-pending/30 text-status-pending-strong"
    >
      <Link
        to={automation.fixUrl}
        className="min-w-0 truncate"
        title={`${detailLabel}. ${fixText}`}
        aria-label={`${detailLabel}. ${fixText}`}
        onClick={(event) => event.stopPropagation()}
      >
        Needs setup
      </Link>
    </Badge>
  );
}
