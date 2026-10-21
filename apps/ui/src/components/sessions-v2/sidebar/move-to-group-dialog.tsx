/**
 * Pick a group (plan Phase 5, SPEC R5): fuzzy over My groups plus No group,
 * and a "Create group #name" row for a name that is not a group yet. It
 * moves sessions (`m`, the row menu, the bulk bar, Cmd+K), or picks where a
 * new session starts (Cmd+K "New session in group…"). One cmdk list in a
 * Dialog, on the dialog timing.
 */

import { FolderInput, FolderPlus, Plus } from "lucide-react";
import { useRef, useState } from "react";
import type { SessionListItem } from "@/api/types";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { type GroupTarget, groupSlug } from "@/lib/session-groups";
import { sessionDisplayTitle } from "@/lib/utils";
import { GroupTargetItems } from "../group-target-items";
import { useLastValue } from "./point-menu";

/** What the picked group is for. */
export type GroupPick = { purpose: "move"; sessions: SessionListItem[] } | { purpose: "new" };

/** "Move "Title" to", "Move 3 sessions to", or "New session in". */
function DialogLead({ pick }: { pick: GroupPick }) {
  if (pick.purpose === "new") {
    return (
      <>
        <Plus aria-hidden className="size-3.5 shrink-0" />
        <span>New session in</span>
      </>
    );
  }
  const [only] = pick.sessions;
  return (
    <>
      <FolderInput aria-hidden className="size-3.5 shrink-0" />
      {pick.sessions.length === 1 && only ? (
        <span className="flex min-w-0">
          <span className="shrink-0">Move "</span>
          <span className="truncate">{sessionDisplayTitle(only.root)}</span>
          <span className="shrink-0">" to</span>
        </span>
      ) : (
        <span>Move {pick.sessions.length} sessions to</span>
      )}
    </>
  );
}

export function MoveToGroupDialog({
  pick,
  targets,
  writeBlock,
  onClose,
  onPickGroup,
  onCreateGroup,
  onRestoreFocus,
}: {
  pick: GroupPick | null;
  targets: GroupTarget[];
  /** Why a write into a group fails here, or null. */
  writeBlock: (key: string) => string | null;
  onClose: () => void;
  /** A group key, or null for No group. */
  onPickGroup: (pick: GroupPick, key: string | null) => void;
  /** A new top-level group from the typed name. */
  onCreateGroup: (pick: GroupPick, name: string) => void;
  /** The dialog closed. `picked`: a group or a new one was chosen (not a cancel). */
  onRestoreFocus: (pick: GroupPick, picked: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = useLastValue(pick);
  const picked = useRef(false);

  const slug = groupSlug(query);
  const exists = targets.some((target) => target.key === `shared/${slug}/`);
  const finish = (run: (current: GroupPick) => void) => {
    if (!shown) return;
    picked.current = true;
    run(shown);
    onClose();
  };

  return (
    <Dialog
      open={pick !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="top-[22%] translate-y-0 overflow-hidden p-0 sm:max-w-xl"
        onOpenAutoFocus={() => {
          picked.current = false;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          setQuery("");
          if (shown) onRestoreFocus(shown, picked.current);
        }}
      >
        <DialogTitle className="sr-only">
          {shown?.purpose === "new" ? "New session in a group" : "Move to group"}
        </DialogTitle>
        <DialogDescription className="sr-only">Pick a group, or type a new name.</DialogDescription>
        <Command loop>
          <div className="flex min-w-0 items-center gap-1.5 border-b border-border-subtle px-3 pt-3 pb-2 text-xs font-medium text-muted-foreground">
            {shown ? <DialogLead pick={shown} /> : null}
          </div>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Pick a group, or type a new name"
          />
          <CommandList className="max-h-[360px]">
            {/* A typed name that is no group yet offers "Create group" instead. */}
            {slug && !exists ? null : <CommandEmpty>No group matches.</CommandEmpty>}
            <CommandGroup heading="Groups">
              <GroupTargetItems
                targets={targets}
                writeBlock={writeBlock}
                onPick={(key) => finish((current) => onPickGroup(current, key))}
              />
            </CommandGroup>
            {slug && !exists ? (
              <CommandGroup heading="Create" forceMount>
                <CommandItem
                  forceMount
                  value={`Create group ${slug}`}
                  onSelect={() => finish((current) => onCreateGroup(current, slug))}
                >
                  <FolderPlus aria-hidden />
                  <span className="min-w-0 truncate">Create group #{slug}</span>
                </CommandItem>
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
