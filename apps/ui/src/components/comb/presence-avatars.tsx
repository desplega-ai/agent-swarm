import { userInitials } from "@/components/shared/user-chip";
import { Avatar, AvatarFallback, AvatarGroupCount, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PEER_FOREGROUND_VAR, peerColorVar } from "@/lib/comb/presence";
import { cn } from "@/lib/utils";
import { type RosterPeer, usePresenceRoster } from "./presence-context";

/** Avatars shown before the rest collapse into "+N". */
const MAX_AVATARS = 3;

function activity(peer: RosterPeer, version: number | undefined): string {
  if (peer.file && version !== undefined && peer.file.version !== version) {
    return `Viewing v${peer.file.version}`;
  }
  return peer.selecting ? "Selecting" : "Viewing";
}

/** One person in an avatar stack: who, their palette slot, and what they are doing. */
export interface StackPeer {
  id: string;
  name: string;
  avatar?: string;
  /** Palette slot, see `peerColor`. */
  color: number;
  /** Tooltip activity, e.g. "Viewing". */
  doing: string;
}

/**
 * A small stack of people: 3 avatars, then "+N". The tooltip names each one
 * and what they are doing. Comb files and session headers share it.
 *
 * `decorative` drops the tooltips and the tab stops, for a row whose own
 * label names the people (a sidebar row in a keyboard list). `size="xs"`
 * (16 px) fits a 26 px row. Its ring takes `--avatar-ring`, so it can match
 * the row's fill.
 */
export function AvatarStack({
  peers,
  label,
  max = MAX_AVATARS,
  size = "sm",
  decorative = false,
  className,
}: {
  peers: StackPeer[];
  /** The group's accessible name. Defaults to the presence wording ("2 other people here"). */
  label?: string;
  /** Avatars before the rest collapse into "+N". */
  max?: number;
  size?: "sm" | "xs";
  decorative?: boolean;
  className?: string;
}) {
  if (peers.length === 0) return null;
  const shown = peers.slice(0, max);
  const rest = peers.slice(max);
  const xs = size === "xs";
  // An xs ring takes the row's fill, so the stack sits flush on a hovered row.
  const ring = xs ? "ring-[var(--avatar-ring,var(--color-background))]" : "ring-background";
  const avatar = (peer: StackPeer) => (
    <Avatar
      key={peer.id}
      size={size}
      tabIndex={decorative ? undefined : 0}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : `${peer.name}, ${peer.doing.toLowerCase()}`}
      className={cn("ring-2 outline-none focus-visible:ring-ring/60", ring)}
    >
      {peer.avatar ? <AvatarImage src={peer.avatar} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback
        className={cn("font-mono font-semibold", !xs && "text-[10px]")}
        style={{ backgroundColor: peerColorVar(peer.color), color: PEER_FOREGROUND_VAR }}
      >
        {userInitials(peer.name)}
      </AvatarFallback>
    </Avatar>
  );
  const more = (
    <AvatarGroupCount
      tabIndex={decorative ? undefined : 0}
      role={decorative ? undefined : "img"}
      aria-label={
        decorative ? undefined : `${rest.length} more: ${rest.map((peer) => peer.name).join(", ")}`
      }
      className={cn(
        "font-mono outline-none focus-visible:ring-ring/60",
        xs ? "size-4 text-[7px]" : "size-6 text-[10px]",
        ring,
      )}
    >
      +{rest.length}
    </AvatarGroupCount>
  );
  if (decorative) {
    return (
      <span aria-hidden className={cn("flex shrink-0 items-center -space-x-1", className)}>
        {shown.map(avatar)}
        {rest.length > 0 ? more : null}
      </span>
    );
  }
  return (
    // `AvatarGroup` rings its children in the background color with a rule
    // that also hides the focus ring, so the stack sets the rings itself.
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls, not avatars
    <div
      role="group"
      aria-label={
        label ?? (peers.length === 1 ? "1 other person here" : `${peers.length} other people here`)
      }
      className={cn("flex items-center", xs ? "-space-x-1" : "-space-x-1.5", className)}
    >
      {shown.map((peer) => (
        <Tooltip key={peer.id}>
          <TooltipTrigger asChild>{avatar(peer)}</TooltipTrigger>
          <TooltipContent side="bottom">
            {peer.name}
            <span className="ml-1.5 opacity-70">{peer.doing}</span>
          </TooltipContent>
        </Tooltip>
      ))}
      {rest.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>{more}</TooltipTrigger>
          <TooltipContent side="bottom">{rest.map((peer) => peer.name).join(", ")}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** The other people on this file, as a small avatar stack. The tooltip says what they do. */
export function PresenceAvatars({ path, version }: { path: string; version: number | undefined }) {
  const here = usePresenceRoster().filter((peer) => peer.file?.path === path);
  return (
    <AvatarStack
      className="mr-1.5"
      peers={here.map((peer) => ({
        id: peer.id,
        name: peer.name,
        avatar: peer.avatar,
        color: peer.color,
        doing: activity(peer, version),
      }))}
    />
  );
}

/** Colored dots for the people on `path` (the Files tree). Decoration: the header names them. */
export function PresenceDots({ path }: { path: string }) {
  const here = usePresenceRoster().filter((peer) => peer.file?.path === path);
  if (here.length === 0) return null;
  return (
    <span aria-hidden className="flex shrink-0 -space-x-0.5">
      {here.slice(0, MAX_AVATARS).map((peer) => (
        <span
          key={peer.id}
          className="size-2 rounded-full ring-1 ring-background"
          style={{ backgroundColor: peerColorVar(peer.color) }}
        />
      ))}
    </span>
  );
}
