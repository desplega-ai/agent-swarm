import { useKeyFavorite, useSessionFavorite } from "@/api/hooks/use-favorites";
import { FavoriteButton } from "@/components/shared/favorite-button";

export const GROUP_STAR_LABELS = { add: "Star this use case", remove: "Unstar" };

/** The star in a group tab's title row. The tab of a section (Inbox, Later, ...) has none. */
export function GroupTabStar({ groupKey }: { groupKey: string | null }) {
  const star = useKeyFavorite(groupKey);
  if (groupKey === null) return null;
  return (
    <FavoriteButton
      favorite={star.favorite}
      disabled={star.disabled}
      onToggle={star.toggle}
      labels={GROUP_STAR_LABELS}
      className="-my-1"
    />
  );
}

export const SESSION_STAR_LABELS = { add: "Star this session", remove: "Unstar" };

/** The star in a session's title row: a starred session lists under Starred in the sidebar. */
export function SessionStar({ rootTaskId }: { rootTaskId: string }) {
  const star = useSessionFavorite(rootTaskId);
  return (
    <FavoriteButton
      favorite={star.favorite}
      disabled={star.disabled}
      onToggle={star.toggle}
      labels={SESSION_STAR_LABELS}
      className="-my-1 shrink-0"
    />
  );
}
