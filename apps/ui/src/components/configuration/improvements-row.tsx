import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { useConfigs } from "@/api/hooks/use-config-api";
import {
  useApproveImprovement,
  useDiscardImprovement,
  useImprovements,
} from "@/api/hooks/use-improvements";
import type { Improvement } from "@/api/types";
import { ImprovementDialog } from "@/components/improvements/improvement-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useCan } from "@/lib/use-can";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

const STATUS_LABEL: Record<Improvement["status"], string> = {
  pending_approval: "Pending",
  sending: "Sending",
  sent: "Sent",
  failed: "Failed",
  discarded: "Discarded",
};

const STATUS_VARIANT: Record<
  Improvement["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending_approval: "outline",
  sending: "secondary",
  sent: "default",
  failed: "destructive",
  discarded: "secondary",
};

const formatTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

function PendingImprovement({ row, canApprove }: { row: Improvement; canApprove: boolean }) {
  const { user } = useCurrentUser();
  const [email, setEmail] = useState(user?.email ?? "");
  const approve = useApproveImprovement();
  const discard = useDiscardImprovement();
  const emailValid = email.trim() === "" || EMAIL_RE.test(email.trim());
  const busy = approve.isPending || discard.isPending;

  const onApprove = async () => {
    try {
      const result = await approve.mutateAsync({ id: row.id, email: email.trim() || null });
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
        <Badge variant={STATUS_VARIANT[row.status]} size="tag">
          {STATUS_LABEL[row.status]}
        </Badge>
        <span>
          {row.requestedByAgentId
            ? `Drafted by agent ${row.requestedByAgentId.slice(0, 8)}`
            : "Drafted by a person"}
          {" · "}
          {formatTime(row.createdAt)}
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
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1 space-y-1">
            <Label htmlFor={`improvement-email-${row.id}`} className="text-xs">
              Email to send with it (optional)
            </Label>
            <Input
              id={`improvement-email-${row.id}`}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={!emailValid}
              className="h-8"
            />
          </div>
          <Button size="sm" onClick={onApprove} disabled={busy || !emailValid}>
            {row.status === "failed" ? "Retry" : "Approve and send"}
          </Button>
          <Button size="sm" variant="outline" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          A person with approval rights must approve it.
        </p>
      )}
    </li>
  );
}

/**
 * Settings → Configuration → Telemetry: drafts waiting for a person, the send
 * history, and a manual submit. The `IMPROVEMENTS_ENABLED` toggle above this
 * section is a plain catalog row.
 */
export function ImprovementsRow() {
  const { data, isError } = useImprovements();
  const canApprove = useCan("improvement.approve");
  const [dialogOpen, setDialogOpen] = useState(false);
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
  const pending = data.improvements.filter(
    (row) => row.status === "pending_approval" || row.status === "failed",
  );
  const history = data.improvements.filter(
    (row) => row.status !== "pending_approval" && row.status !== "failed",
  );

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
          approves each one, and only its text, the email you choose and, while telemetry is on, the
          install id are sent.
        </p>
      </div>
      {data.enabled ? (
        <>
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            Suggest an improvement
          </Button>
          <ImprovementDialog open={dialogOpen} onOpenChange={setDialogOpen} />
          {pending.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-medium">Waiting for approval</p>
              <ul className="space-y-2">
                {pending.map((row) => (
                  <PendingImprovement key={row.id} row={row} canApprove={canApprove} />
                ))}
              </ul>
            </div>
          ) : null}
        </>
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
                  <Badge variant={STATUS_VARIANT[row.status]} size="tag">
                    {STATUS_LABEL[row.status]}
                  </Badge>
                  <span>{row.requestedByAgentId ? "Agent draft" : "Person"}</span>
                  {row.approvedBy ? <span>Approved by {row.approvedBy}</span> : null}
                  <span>{formatTime(row.sentAt ?? row.updatedAt)}</span>
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
