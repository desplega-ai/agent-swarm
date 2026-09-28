import { Star } from "lucide-react";

/**
 * Header for the 52px favorite (star) column on list grids. The column is too
 * narrow for a word, and a blank header left it unexplained; a muted star says
 * what the column holds, and the label carries it for screen readers.
 */
export function FavoriteColumnHeader() {
  return (
    <span className="flex w-full items-center justify-center" title="Favorite">
      <Star className="size-3.5 text-muted-foreground" aria-hidden />
      <span className="sr-only">Favorite</span>
    </span>
  );
}

/** Shared column props: pair with a `FavoriteButton` cell renderer. */
export const FAVORITE_COLUMN = {
  headerName: "Favorite",
  headerComponent: FavoriteColumnHeader,
  width: 52,
  sortable: false,
  filter: false,
  resizable: false,
} as const;
