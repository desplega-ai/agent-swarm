import { KeyRound, Unplug } from "lucide-react";
import { useState } from "react";
import { StatusIcon } from "@/components/shared/status-icon";
import { userInitials } from "@/components/shared/user-chip";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { cn } from "@/lib/utils";
import { useLiveStatus } from "./live-indicator";
import { usePresenceControl } from "./presence-context";

/**
 * The agent-fs account at the right end of the Comb header: initials with a
 * dot (green while the change stream is live). The menu says who is
 * connected, with which key, and how the view stays fresh. It holds "Show
 * cursors" (other people's pointers and selections), "Manage keys in
 * agent-fs", and "Forget this browser's key" (the next page load mints a new
 * one).
 */
export function CombAccountMenu() {
  const { me, credential, liveUrl, disconnect } = useAgentFs();
  const keyLabel = credential?.label ?? null;
  const keysUrl = liveUrl ? `${liveUrl.replace(/\/+$/, "")}/credentials` : null;
  const status = useLiveStatus();
  const presence = usePresenceControl();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const name = me?.displayName || me?.email || "agent-fs";
  const email = me?.displayName && me.email ? me.email : null;
  const connectedAs = `Connected as ${name}`;

  return (
    <>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full"
                aria-label={`${connectedAs}. ${status.title}.`}
              >
                <span className="relative flex size-7 items-center justify-center rounded-full bg-muted font-mono text-[10px] font-semibold text-foreground">
                  {userInitials(name)}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute right-0 bottom-0 size-2 rounded-full ring-2 ring-background",
                      status.live ? "bg-status-success" : "bg-status-neutral",
                    )}
                  />
                </span>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">{connectedAs}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-72">
          <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
            <span className="text-xs text-muted-foreground">Connected to agent-fs as</span>
            <span className="truncate font-medium">{name}</span>
            {email ? <span className="truncate text-xs text-muted-foreground">{email}</span> : null}
            {keyLabel ? (
              <span className="mt-1 flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
                <KeyRound className="mt-0.5 size-3 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">{keyLabel}</span>
              </span>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="flex flex-col gap-1 px-2 py-1.5 text-sm">
            <span className="flex items-center gap-1.5 font-medium">
              <StatusIcon tone={status.tone} focusable={false} />
              {status.title}
            </span>
            <p className="text-xs text-muted-foreground">{status.reason}</p>
          </div>
          <DropdownMenuSeparator />
          {presence ? (
            <>
              <DropdownMenuCheckboxItem
                checked={presence.showCursors}
                onCheckedChange={(checked) => presence.setShowCursors(checked === true)}
                // The menu stays open, so the new state shows.
                onSelect={(event) => event.preventDefault()}
              >
                Show cursors
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {keysUrl ? (
            <DropdownMenuItem asChild>
              <a href={keysUrl} target="_blank" rel="noopener noreferrer">
                <KeyRound />
                Manage keys in agent-fs
              </a>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmOpen(true)}>
            <Unplug />
            Forget this browser's key
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Forget this browser's key?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the agent-fs key from this browser. The next visit creates a new one.
              Your agent-fs account and files stay. To revoke the old key, use Manage keys in
              agent-fs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep key</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={disconnect}>
              Forget key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
