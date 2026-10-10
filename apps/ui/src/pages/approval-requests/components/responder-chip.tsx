import { KeyRound } from "lucide-react";
import { UserChip } from "@/components/shared/user-chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useUserLookup } from "@/hooks/use-user-name";
import { OPERATOR_RESPONDER } from "@/lib/approval-format";
import { cn } from "@/lib/utils";

/**
 * Who answered, as the server recorded it from the credential. A user is a
 * `UserChip`; the shared operator key is "Operator key", because no person is
 * recorded for it. `claimed` is the unverified name the client sent, shown
 * only next to the operator key, where it is the one hint of who clicked.
 */
export function ResponderChip({
  responder,
  claimed,
  className,
}: {
  responder: string;
  claimed?: string | null;
  className?: string;
}) {
  const lookupUser = useUserLookup();
  if (responder !== OPERATOR_RESPONDER) {
    return <UserChip userRef={responder} user={lookupUser(responder)} className={className} />;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex min-w-0 max-w-full cursor-default items-center gap-1.5 rounded-full align-middle text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            className,
          )}
        >
          <span
            aria-hidden
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-muted"
          >
            <KeyRound className="size-3" />
          </span>
          <span className="min-w-0 truncate font-medium">Operator key</span>
          {claimed ? (
            <span className="min-w-0 truncate text-muted-foreground">(as {claimed})</span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-[11px]">
        Answered with the shared operator key, so no person is recorded.
        {claimed ? ` "${claimed}" is the name the dashboard sent; it is not verified.` : null}
      </TooltipContent>
    </Tooltip>
  );
}
