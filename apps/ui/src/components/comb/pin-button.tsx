import { toast } from "sonner";
import { useFavorites, useFavoriteToggle } from "@/api/hooks/use-favorites";
import { FavoriteButton } from "@/components/shared/favorite-button";
import { type DrivePath, pinIdFor } from "@/lib/comb/paths";

const PIN_LABELS = { add: "Add to favorites", remove: "Remove from favorites" };

/**
 * Star that makes a Comb file or folder a favorite (type `agent-fs-path`):
 * the Favorites tab, the Comb home, and the sidebar list it.
 */
export function PinButton({ target, className }: { target: DrivePath; className?: string }) {
  const pins = useFavorites("agent-fs-path");
  const toggle = useFavoriteToggle("agent-fs-path");
  // An API without pins rejects the item type. Show no star then.
  if (pins.isError && !pins.data) return null;

  const itemId = pinIdFor(target);
  const pinned = pins.data?.favoriteIds.includes(itemId) ?? false;
  return (
    <FavoriteButton
      favorite={pinned}
      disabled={!pins.data || toggle.isPending}
      labels={PIN_LABELS}
      className={className}
      onToggle={() =>
        toggle.mutate(
          { itemId, favorite: !pinned },
          {
            onError: () =>
              toast.error(
                pinned ? "Could not remove the favorite." : "Could not add the favorite.",
              ),
          },
        )
      }
    />
  );
}
