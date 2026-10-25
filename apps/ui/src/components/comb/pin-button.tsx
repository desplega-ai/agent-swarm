import { toast } from "sonner";
import { isCombFavorite, useCombFavorites } from "@/api/hooks/use-comb-favorites";
import { FavoriteButton } from "@/components/shared/favorite-button";
import type { DrivePath } from "@/lib/comb/paths";

const PIN_LABELS = { add: "Add to favorites", remove: "Remove from favorites" };

/**
 * Star that makes a Comb file or folder a favorite (`useCombFavorites`: the
 * agent-fs stars, shared with the live UI): the Favorites tab, the Comb home,
 * and the sidebar list it.
 */
export function PinButton({ target, className }: { target: DrivePath; className?: string }) {
  const favorites = useCombFavorites(target);
  if (!favorites.available) return null;
  const pinned = isCombFavorite(favorites, target);
  return (
    <FavoriteButton
      favorite={pinned}
      disabled={!favorites.ids || favorites.isToggling}
      labels={PIN_LABELS}
      className={className}
      onToggle={() =>
        favorites.toggle(target, !pinned, {
          onError: () =>
            toast.error(pinned ? "Could not remove the favorite." : "Could not add the favorite."),
        })
      }
    />
  );
}
