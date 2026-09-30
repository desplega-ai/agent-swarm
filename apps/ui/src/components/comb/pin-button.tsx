import { toast } from "sonner";
import { useFavorites, useFavoriteToggle } from "@/api/hooks/use-favorites";
import { FavoriteButton } from "@/components/shared/favorite-button";
import { type DrivePath, pinIdFor } from "@/lib/comb/paths";

const PIN_LABELS = { add: "Pin to sidebar", remove: "Unpin" };

/** Star that pins a Comb file or folder to the sidebar (a favorite of type `agent-fs-path`). */
export function PinButton({ target }: { target: DrivePath }) {
  const pins = useFavorites("agent-fs-path");
  const toggle = useFavoriteToggle("agent-fs-path");
  // An API without pins rejects the item type. Show no star then.
  if (pins.isError) return null;

  const itemId = pinIdFor(target);
  const pinned = pins.data?.favoriteIds.includes(itemId) ?? false;
  return (
    <FavoriteButton
      favorite={pinned}
      disabled={!pins.data || toggle.isPending}
      labels={PIN_LABELS}
      onToggle={() =>
        toggle.mutate(
          { itemId, favorite: !pinned },
          { onError: () => toast.error(pinned ? "Could not unpin." : "Could not pin.") },
        )
      }
    />
  );
}
