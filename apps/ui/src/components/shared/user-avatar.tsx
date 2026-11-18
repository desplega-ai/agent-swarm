import { UserRound } from "lucide-react";
import { useUsers } from "@/api/hooks/use-users";
import type { MediaIcon } from "@/api/types";
import { MediaIconGlyph } from "@/components/shared/media-icon-glyph";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { PEER_FOREGROUND_VAR, peerColor, peerColorVar } from "@/lib/comb/presence";
import { userInitials } from "@/lib/user-initials";
import { cn } from "@/lib/utils";

const GLYPH_SIZES = { xs: "size-2.5", sm: "size-3.5", default: "size-4" } as const;

/**
 * The user's stored avatar from the users list already in the query cache.
 * Never fetches: token-bound tabs skip the user directory (DES-771).
 * shortcut: a tab that never loaded the directory shows initials, pass `avatar` to override.
 */
function useCachedUserAvatar(id: string): MediaIcon | null {
  const { data: users } = useUsers({ enabled: false });
  return users?.find((user) => user.id === id)?.avatar ?? null;
}

/**
 * One person as an avatar: their custom avatar (a glyph, a link, or an
 * agent-fs image) when set, else initials on the same palette slot
 * (`peerColor` of the id) as `AvatarStack`, so a person looks the same in both.
 */
export function UserAvatar({
  id,
  name,
  avatar,
  size = "sm",
  className,
}: {
  id: string;
  name: string;
  /** The user's avatar when the caller has it. Unset reads it from the cached users list. */
  avatar?: MediaIcon | null;
  /** `xs` (16 px) fits a 28 px sidebar row, like `AvatarStack size="xs"`. */
  size?: "xs" | "sm" | "default";
  className?: string;
}) {
  const cached = useCachedUserAvatar(id);
  const icon = avatar !== undefined ? avatar : cached;
  const initials = (
    <AvatarFallback
      className={cn("font-mono font-semibold", size !== "xs" && "text-[10px]")}
      style={{ backgroundColor: peerColorVar(peerColor(id)), color: PEER_FOREGROUND_VAR }}
    >
      {userInitials(name)}
    </AvatarFallback>
  );
  let body = initials;
  if (icon?.type === "lucide") {
    // The color fills the disc, so the glyph itself stays the foreground color.
    body = (
      <span
        className="flex size-full items-center justify-center rounded-full"
        style={{
          backgroundColor: icon.color ?? peerColorVar(peerColor(id)),
          color: PEER_FOREGROUND_VAR,
        }}
      >
        <MediaIconGlyph
          icon={{ type: "lucide", icon: icon.icon }}
          fallback={UserRound}
          className={GLYPH_SIZES[size]}
        />
      </span>
    );
  } else if (icon) {
    body = (
      <MediaIconGlyph
        icon={icon}
        fallback={UserRound}
        imageFallback={initials}
        imageClassName="size-full rounded-full bg-background"
      />
    );
  }
  return (
    <Avatar size={size} role="img" aria-label={name} className={cn("shrink-0", className)}>
      {body}
    </Avatar>
  );
}
