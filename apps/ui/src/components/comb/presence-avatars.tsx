import { userInitials } from "@/components/shared/user-chip";
import { Avatar, AvatarFallback, AvatarGroupCount, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { PEER_FOREGROUND_VAR, peerColorVar } from "@/lib/comb/presence";
import { type RosterPeer, usePresenceRoster } from "./presence-context";

/** Avatars shown before the rest collapse into "+N". */
const MAX_AVATARS = 3;

function activity(peer: RosterPeer, version: number | undefined): string {
  if (peer.file && version !== undefined && peer.file.version !== version) {
    return `Viewing v${peer.file.version}`;
  }
  return peer.selecting ? "Selecting" : "Viewing";
}

/** The other people on this file, as a small avatar stack. The tooltip says what they do. */
export function PresenceAvatars({ path, version }: { path: string; version: number | undefined }) {
  const here = usePresenceRoster().filter((peer) => peer.file?.path === path);
  if (here.length === 0) return null;
  const shown = here.slice(0, MAX_AVATARS);
  const rest = here.slice(MAX_AVATARS);
  return (
    // `AvatarGroup` rings its children in the background color with a rule
    // that also hides the focus ring, so the stack sets the rings itself.
    // biome-ignore lint/a11y/useSemanticElements: a fieldset groups form controls, not avatars
    <div
      role="group"
      aria-label={here.length === 1 ? "1 other person here" : `${here.length} other people here`}
      className="mr-1.5 flex items-center -space-x-1.5"
    >
      {shown.map((peer) => {
        const doing = activity(peer, version);
        return (
          <Tooltip key={peer.id}>
            <TooltipTrigger asChild>
              <Avatar
                size="sm"
                tabIndex={0}
                role="img"
                aria-label={`${peer.name}, ${doing.toLowerCase()}`}
                className="ring-2 ring-background outline-none focus-visible:ring-ring/60"
              >
                {peer.avatar ? (
                  <AvatarImage src={peer.avatar} alt="" referrerPolicy="no-referrer" />
                ) : null}
                <AvatarFallback
                  className="font-mono text-[10px] font-semibold"
                  style={{ backgroundColor: peerColorVar(peer.color), color: PEER_FOREGROUND_VAR }}
                >
                  {userInitials(peer.name)}
                </AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {peer.name}
              <span className="ml-1.5 opacity-70">{doing}</span>
            </TooltipContent>
          </Tooltip>
        );
      })}
      {rest.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <AvatarGroupCount
              tabIndex={0}
              role="img"
              aria-label={`${rest.length} more: ${rest.map((peer) => peer.name).join(", ")}`}
              className="size-6 font-mono text-[10px] outline-none focus-visible:ring-ring/60"
            >
              +{rest.length}
            </AvatarGroupCount>
          </TooltipTrigger>
          <TooltipContent side="bottom">{rest.map((peer) => peer.name).join(", ")}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
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
