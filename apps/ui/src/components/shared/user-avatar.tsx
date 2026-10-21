import { userInitials } from "@/components/shared/user-chip";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { PEER_FOREGROUND_VAR, peerColor, peerColorVar } from "@/lib/comb/presence";
import { cn } from "@/lib/utils";

/**
 * One person as an initials avatar, for message bubbles. Users have no
 * avatar image, so it uses the same palette slot (`peerColor` of the id) and
 * initials as `AvatarStack`, and a person looks the same in both.
 */
export function UserAvatar({
  id,
  name,
  size = "sm",
  className,
}: {
  id: string;
  name: string;
  /** `xs` (16 px) fits a 28 px sidebar row, like `AvatarStack size="xs"`. */
  size?: "xs" | "sm" | "default";
  className?: string;
}) {
  return (
    <Avatar size={size} role="img" aria-label={name} className={cn("shrink-0", className)}>
      <AvatarFallback
        className={cn("font-mono font-semibold", size !== "xs" && "text-[10px]")}
        style={{ backgroundColor: peerColorVar(peerColor(id)), color: PEER_FOREGROUND_VAR }}
      >
        {userInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
