import { ArrowRight, Hourglass } from "lucide-react";
import { Link } from "react-router-dom";
import type { SessionApproval } from "@/api/types";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Button } from "@/components/ui/button";

/** A pending approval in the session (plan D6): the swarm waits on a person. */
export function ApprovalLine({ approval }: { approval: SessionApproval }) {
  return (
    <AlertCallout
      tone="active"
      icon={Hourglass}
      title="Waiting for approval"
      // Part of the timeline, not news: no alert on every open.
      role="note"
      action={
        // Touch screens: a 44 px tap area (UX review R9).
        <Button asChild size="sm" variant="outline" className="hit-area [--hit-size:44px]">
          <Link to={`/approval-requests/${approval.id}`}>
            Review
            <ArrowRight />
          </Link>
        </Button>
      }
    >
      <span className="text-sm wrap-anywhere text-foreground">{approval.title}</span>
    </AlertCallout>
  );
}
