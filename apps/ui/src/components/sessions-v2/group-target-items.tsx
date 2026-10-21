/**
 * The group rows of a cmdk list: My groups, then No group (the move dialog,
 * the Start in picker). The filter reads only the path the user sees, never
 * a key, so "per" or part of a user id does not match every personal group.
 * A group this connection cannot write into shows its reason and cannot be
 * picked.
 */

import { Check, Hash, Lock, SquareDashed } from "lucide-react";
import { CommandItem } from "@/components/ui/command";
import type { GroupTarget } from "@/lib/session-groups";

/** The cmdk value of a group: its path. A personal path that a shared group also uses says so. */
export function groupItemValue(target: GroupTarget): string {
  return target.privateClash ? `${target.label} (only you)` : target.label;
}

/** The cmdk value of the No group row. */
export const NO_GROUP_VALUE = "No group";

export function GroupTargetItems({
  targets,
  picked,
  writeBlock,
  onPick,
}: {
  targets: GroupTarget[];
  /** The checked row: a group key, null for No group, undefined for none. */
  picked?: string | null;
  /** Why a write into a group fails here, or null. */
  writeBlock: (key: string) => string | null;
  /** A group key, or null for No group. */
  onPick: (key: string | null) => void;
}) {
  return (
    <>
      {targets.map((target) => {
        const reason = writeBlock(target.key);
        return (
          <CommandItem
            key={target.key}
            value={groupItemValue(target)}
            disabled={reason !== null}
            onSelect={() => onPick(target.key)}
          >
            <Hash aria-hidden />
            <span className="min-w-0 truncate">{target.label}</span>
            {target.privateClash ? (
              <Lock aria-label="Only you" className="size-3 shrink-0 text-muted-foreground" />
            ) : null}
            {reason ? (
              <span className="ml-auto shrink-0 pl-3 text-meta text-muted-foreground">
                {reason}
              </span>
            ) : target.key === picked ? (
              <Check aria-label="Picked" className="ml-auto" />
            ) : null}
          </CommandItem>
        );
      })}
      <CommandItem value={NO_GROUP_VALUE} onSelect={() => onPick(null)}>
        <SquareDashed aria-hidden />
        No group
        {picked === null ? <Check aria-label="Picked" className="ml-auto" /> : null}
      </CommandItem>
    </>
  );
}
