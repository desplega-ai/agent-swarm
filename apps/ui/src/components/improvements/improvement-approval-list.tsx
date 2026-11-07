import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { useApproveImprovement, useDiscardImprovement } from "@/api/hooks/use-improvements";
import type { Improvement } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCurrentUser } from "@/contexts/current-user-context";
import { isValidImprovementEmail } from "./improvement-email";

/** Split `text` into plain and highlighted parts at every leak-hint match (case-insensitive). */
export function highlightLeakHints(text: string, hints: string[] | undefined): ReactNode[] {
  const terms = (hints ?? []).filter((hint) => hint.length > 0);
  if (terms.length === 0) return [text];
  const escaped = terms
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(${escaped.join("|")})`, "gi");
  return text.split(re).map((part, index) =>
    index % 2 === 1 ? (
      <mark
        key={index}
        className="rounded-sm bg-status-warning px-0.5 text-status-warning-foreground"
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

export const IMPROVEMENT_STATUS_LABEL: Record<Improvement["status"], string> = {
  pending_approval: "Pending",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  discarded: "Discarded",
};

export const IMPROVEMENT_STATUS_VARIANT: Record<
  Improvement["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending_approval: "outline",
  sending: "secondary",
  sent: "default",
  failed: "destructive",
  discarded: "secondary",
};

export const formatImprovementTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString() : null;

/** Rows a person still has to act on. */
export const isActionableImprovement = (row: Improvement) =>
  row.status === "pending_approval" || row.status === "failed";

function PendingImprovement({ row, canApprove }: { row: Improvement; canApprove: boolean }) {
  const { user } = useCurrentUser();
  const [email, setEmail] = useState(user?.email ?? "");
  const approve = useApproveImprovement();
  const discard = useDiscardImprovement();
  const emailValid = isValidImprovementEmail(email);
  const busy = approve.isPending || discard.isPending;

  const onApprove = async () => {
    try {
      const result = await approve.mutateAsync({ id: row.id, email: email.trim() });
      if (result.status === "sent") toast.success("Improvement sent.");
      else toast.error(`Send failed${result.proxyStatus ? ` (${result.proxyStatus})` : ""}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not approve.");
    }
  };
  const onDiscard = async () => {
    try {
      await discard.mutateAsync(row.id);
      toast.success("Improvement discarded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not discard.");
    }
  };

  return (
    <li className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={IMPROVEMENT_STATUS_VARIANT[row.status]} size="tag">
          {IMPROVEMENT_STATUS_LABEL[row.status]}
        </Badge>
        <span>
          {row.requestedByAgentId
            ? `Drafted by agent ${row.requestedByAgentId.slice(0, 8)}`
            : "Drafted by a person"}
          {" · "}
          {formatImprovementTime(row.createdAt)}
        </span>
        {row.status === "failed" && row.proxyStatus ? (
          <span>Proxy answered {row.proxyStatus}</span>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">
        {highlightLeakHints(row.text, row.leakHints)}
      </p>
      {row.leakHints && row.leakHints.length > 0 ? (
        <p className="text-xs text-status-warning-strong">
          Highlighted parts look specific to this install. Discard and redraft to remove them.
        </p>
      ) : null}
      {canApprove ? (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor={`improvement-email-${row.id}`} className="text-xs">
              Your email
            </Label>
            <Input
              id={`improvement-email-${row.id}`}
              type="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={!emailValid}
              placeholder="you@company.com"
              className="h-8"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={onApprove} disabled={busy || !emailValid}>
              {row.status === "failed" ? "Retry" : "Approve and send"}
            </Button>
            <Button size="sm" variant="outline" onClick={onDiscard} disabled={busy}>
              Discard
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          A person with approval rights must approve it.
        </p>
      )}
    </li>
  );
}

/** Drafts waiting for a person (pending or failed), each with approve and discard. */
export function ImprovementApprovalList({
  rows,
  canApprove,
}: {
  rows: Improvement[];
  canApprove: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">No drafts waiting for approval.</p>;
  }
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <PendingImprovement key={row.id} row={row} canApprove={canApprove} />
      ))}
    </ul>
  );
}
