import { FilePen, History, type LucideIcon, Star } from "lucide-react";
import type { ReactNode } from "react";
import {
  FavoritesList,
  RecentChangesList,
  RecentlyViewedList,
} from "@/components/comb/recent-lists";

/** Rows each home card shows. The left panel's Recent and Favorites tabs show the rest. */
const HOME_ROWS = 3;

function HomeCard({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex min-w-0 flex-col rounded-xl border border-border bg-card"
    >
      <h2 className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle px-3 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        {title}
      </h2>
      <div className="p-1">{children}</div>
    </section>
  );
}

/**
 * The Comb home, above the drive root's listing: the newest favorites,
 * recently viewed files (this browser), and recently changed files (anyone).
 */
export function CombHome({ drive }: { drive: { orgId: string; driveId: string } }) {
  return (
    <div className="grid shrink-0 gap-3 md:grid-cols-3">
      <HomeCard icon={Star} title="Favorites">
        <FavoritesList drive={drive} limit={HOME_ROWS} />
      </HomeCard>
      <HomeCard icon={History} title="Recently viewed">
        <RecentlyViewedList drive={drive} limit={HOME_ROWS} />
      </HomeCard>
      <HomeCard icon={FilePen} title="Recently changed">
        <RecentChangesList drive={drive} limit={HOME_ROWS} />
      </HomeCard>
    </div>
  );
}
