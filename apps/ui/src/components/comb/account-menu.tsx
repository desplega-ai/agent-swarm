import { Unplug } from "lucide-react";
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
 * connected and how the view stays fresh, and holds "Show cursors" (other
 * people's pointers and selections) and Disconnect.
 */
export function CombAccountMenu() {
  const { me, disconnect } = useAgentFs();
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
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirmOpen(true)}>
            <Unplug />
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect agent-fs?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes your agent-fs key from this browser. Your agent-fs account and files
              stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep connected</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={disconnect}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
