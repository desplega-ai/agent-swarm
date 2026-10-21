/**
 * Sessions surface: the Share button and its Google Docs style dialog.
 *
 * - "Add people…" picks a user, who lands at Can view.
 * - Each person has one Can view / Can edit / Remove select.
 * - General access: Private / Everyone can view / Everyone can edit.
 *
 * Every change applies at once with one `PUT` of the full share state (no
 * Save step); a failure rolls back and toasts. The server keeps history: a
 * removal or access change revokes the old share instead of deleting it.
 */

import { Globe, Link2, Lock, Share2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useSessionShares, useUpdateSessionShares } from "@/api/hooks/use-sessions";
import { useUsers } from "@/api/hooks/use-users";
import type { SessionEveryoneAccess, SessionOwner, SessionShares } from "@/api/types";
import { userInitials } from "@/components/shared/user-chip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCurrentUser } from "@/contexts/current-user-context";
import { useConfig } from "@/hooks/use-config";
import { PEER_FOREGROUND_VAR, peerColor, peerColorVar } from "@/lib/comb/presence";
import { isUserTokenApiKey } from "@/lib/config";
import {
  addPerson,
  EVERYONE_OPTIONS,
  type PersonShareChoice,
  setEveryone,
  setPerson,
} from "@/lib/session-sharing";
import { PersonRow } from "./person-row";

export interface ShareSessionButtonProps {
  rootTaskId: string;
  title: string;
  owner: SessionOwner;
  /** An icon button with a "Share" tooltip (the sessions v2 header). */
  icon?: boolean;
  /** Set both to open the dialog from another control (the People popover's "Share…"). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where the focus goes when the dialog closes. Default: back to the button. */
  onCloseAutoFocus?: (event: Event) => void;
}

/** The Share button. Renders nothing until the server confirms it supports shares. */
export function ShareSessionButton({
  rootTaskId,
  title,
  owner,
  icon = false,
  open: openProp,
  onOpenChange,
  onCloseAutoFocus,
}: ShareSessionButtonProps) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  const setOpen = onOpenChange ?? setOwnOpen;
  const { data: shares } = useSessionShares(rootTaskId);
  // `null`: the API predates session sharing. `undefined`: still loading.
  if (!shares) return null;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {icon ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Share"
                className="size-7 text-muted-foreground hover:text-foreground"
              >
                <Share2 className="size-3.5" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent>Share</TooltipContent>
        </Tooltip>
      ) : (
        <DialogTrigger asChild>
          <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs">
            <Share2 className="h-3.5 w-3.5" />
            Share
          </Button>
        </DialogTrigger>
      )}
      {/* One shrinkable column: a long session title truncates instead of
          widening the grid track past the dialog. */}
      <DialogContent
        className="grid-cols-[minmax(0,1fr)] sm:max-w-md"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <ShareSessionDialogBody
          rootTaskId={rootTaskId}
          title={title}
          owner={owner}
          shares={shares}
          onDone={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function PersonAvatar({ id, name }: { id: string; name: string }) {
  return (
    <Avatar size="sm" aria-hidden>
      <AvatarFallback
        className="font-mono text-[10px] font-semibold"
        style={{ backgroundColor: peerColorVar(peerColor(id)), color: PEER_FOREGROUND_VAR }}
      >
        {userInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

/** A person in this dialog: the shared row with this dialog's avatar and "(you)". */
function ShareRow({
  id,
  name,
  isYou,
  detail,
  children,
}: {
  id: string;
  name: string;
  isYou?: boolean;
  detail?: string;
  children: React.ReactNode;
}) {
  return (
    <PersonRow
      avatar={<PersonAvatar id={id} name={name} />}
      name={
        <span className="truncate">
          {name}
          {isYou ? " (you)" : ""}
        </span>
      }
      detail={detail}
    >
      {children}
    </PersonRow>
  );
}

/** General access as an icon: Lock = Private, Globe = Everyone can view, Users = Everyone can edit. */
export const EVERYONE_ICON: Record<SessionEveryoneAccess, typeof Lock> = {
  none: Lock,
  read: Globe,
  write: Users,
};

function ShareSessionDialogBody({
  rootTaskId,
  title,
  owner,
  shares,
  onDone,
}: Pick<ShareSessionButtonProps, "rootTaskId" | "title" | "owner"> & {
  shares: SessionShares;
  onDone: () => void;
}) {
  const { userId } = useCurrentUser();
  const { config } = useConfig();
  const { data: users } = useUsers();
  const update = useUpdateSessionShares(rootTaskId);
  const apply = (next: SessionShares) => update.mutate(next);

  const userById = useMemo(() => new Map((users ?? []).map((u) => [u.id, u])), [users]);
  const addOptions = useMemo(
    () =>
      (users ?? [])
        .filter((u) => u.id !== owner.id && !shares.users.some((s) => s.userId === u.id))
        .map((u) => ({ value: u.id, label: u.name, hint: u.email })),
    [users, owner.id, shares.users],
  );

  const everyone = EVERYONE_OPTIONS.find((o) => o.value === shares.everyone) ?? EVERYONE_OPTIONS[0];
  const EveryoneIcon = EVERYONE_ICON[everyone.value];

  const copyLink = () => {
    const link = `${window.location.origin}/sessions/${rootTaskId}`;
    navigator.clipboard.writeText(link).then(
      () => toast.success("Link copied"),
      () => toast.error("Couldn't copy the link"),
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle className="truncate pr-6">Share “{title}”</DialogTitle>
        <DialogDescription className="sr-only">
          Choose who can view or send messages in this session.
        </DialogDescription>
      </DialogHeader>

      <SearchableSelect
        value=""
        onChange={(id) => apply(addPerson(shares, id, owner.id))}
        options={addOptions}
        placeholder="Add people…"
        searchPlaceholder="Search people"
        emptyLabel="No one else to add."
        aria-label="Add people"
        triggerClassName="w-full"
      />

      <section className="flex flex-col gap-1">
        <h3 className="text-xs font-medium text-muted-foreground">People with access</h3>
        <ul className="flex flex-col">
          <ShareRow
            id={owner.id}
            name={owner.name}
            isYou={owner.id === userId}
            detail={userById.get(owner.id)?.email}
          >
            <span className="px-2 text-xs text-muted-foreground">Owner</span>
          </ShareRow>
          {shares.users.map((share) => {
            const person = userById.get(share.userId);
            const name = person?.name ?? share.userId.slice(0, 8);
            return (
              <ShareRow
                key={share.userId}
                id={share.userId}
                name={name}
                isYou={share.userId === userId}
                detail={person?.email}
              >
                <Select
                  value={share.access}
                  onValueChange={(choice) =>
                    apply(setPerson(shares, share.userId, choice as PersonShareChoice))
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="h-7 w-[7.5rem] text-xs"
                    aria-label={`Access for ${name}`}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="read">Can view</SelectItem>
                    <SelectItem value="write">Can edit</SelectItem>
                    <SelectItem value="remove" className="text-status-error-strong">
                      Remove
                    </SelectItem>
                  </SelectContent>
                </Select>
              </ShareRow>
            );
          })}
        </ul>
      </section>

      <section className="flex flex-col gap-1.5">
        <h3 className="text-xs font-medium text-muted-foreground">General access</h3>
        <div className="flex items-center gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted">
            <EveryoneIcon className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Select
              value={shares.everyone}
              onValueChange={(value) => apply(setEveryone(shares, value as SessionEveryoneAccess))}
            >
              <SelectTrigger
                size="sm"
                className="h-7 w-fit border-transparent px-1.5 text-sm shadow-none hover:bg-muted"
                aria-label="General access"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVERYONE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="px-1.5 text-xs text-muted-foreground">{everyone.description}</span>
          </div>
        </div>
      </section>

      {!isUserTokenApiKey(config.apiKey) ? (
        <p className="text-xs text-muted-foreground">Shared-key users are not blocked.</p>
      ) : null}

      <DialogFooter className="flex-row justify-between sm:justify-between">
        <Button type="button" variant="outline" size="sm" onClick={copyLink} className="gap-1.5">
          <Link2 className="h-3.5 w-3.5" />
          Copy link
        </Button>
        <Button type="button" size="sm" onClick={onDone}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
