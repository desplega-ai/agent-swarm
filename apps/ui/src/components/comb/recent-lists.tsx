import { Ellipsis, StarOff } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useRecentChanges } from "@/api/hooks/use-agent-fs";
import { useCombFavorites } from "@/api/hooks/use-comb-favorites";
import { FileKindIcon } from "@/components/comb/file-icon";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { useViewedFiles } from "@/components/comb/use-viewed-files";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MiddleTruncation } from "@/components/ui/middle-truncation";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { combPath, type DrivePath, drivePins, isFolderPath, pinLabel } from "@/lib/comb/paths";
import { type Drive, folderLabel, VIEWED_MAX } from "@/lib/comb/recent";
import { isUnknownOpError } from "@/lib/comb/search";
import { formatRelative } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

// The Comb file lists: Favorites, Recently viewed, and Recently changed. The
// Comb home shows the top of each in a card, and the left panel's Recent and
// Favorites tabs show them whole.

interface ListProps {
  drive: Drive;
  /** The path on screen: its row is marked. */
  current?: string;
  /** Most rows to show. */
  limit?: number;
  /** A row opened a file (the phone sheet closes). */
  onNavigate?: () => void;
}

/** Rows a list shows when no `limit` is given. */
const FULL_LIST = 20;

/** A list with nothing to show yet: one muted line. */
function ListNote({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <p
      className={cn(
        "px-2 py-3 text-xs",
        tone === "error" ? "text-status-error-strong" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

/** One file or folder: icon, name, a muted second line, and an optional time. */
function ListRow({
  target,
  detail,
  aside,
  current,
  onNavigate,
  actions,
}: {
  target: DrivePath;
  /** The second line: where the file sits, and who changed it. Part of the link name. */
  detail: string;
  aside?: ReactNode;
  current: boolean;
  onNavigate?: () => void;
  actions?: ReactNode;
}) {
  const label = pinLabel(target.path);
  return (
    <li
      className={cn(
        "group hover-linger flex min-w-0 items-center rounded-md transition-colors hover:bg-accent/50",
        current && "bg-accent",
      )}
    >
      <Link
        to={combPath(target)}
        // The visible name can be cut in the middle. The detail tells same-named files apart.
        aria-label={`${label}, ${detail}`}
        aria-current={current ? "page" : undefined}
        title={target.path}
        onClick={onNavigate}
        className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <FileKindIcon name={label} isFolder={isFolderPath(target.path)} className="mt-0.5" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <MiddleTruncation title={undefined} className="min-w-0 flex-1 text-sm">
              {label}
            </MiddleTruncation>
            {aside ? (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{aside}</span>
            ) : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">{detail}</span>
        </span>
      </Link>
      {actions}
    </li>
  );
}

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2 px-2 py-1.5" aria-busy="true">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-8 w-full" />
      ))}
    </div>
  );
}

/** The files this browser opened on the drive, newest first. */
export function RecentlyViewedList({ drive, current, limit = VIEWED_MAX, onNavigate }: ListProps) {
  const viewed = useViewedFiles(drive).slice(0, limit);
  if (viewed.length === 0) return <ListNote>Files you open show here.</ListNote>;
  return (
    <ul aria-label="Recently viewed" className="flex flex-col gap-px">
      {viewed.map((entry) => (
        <ListRow
          key={entry.path}
          target={{ ...drive, path: entry.path }}
          detail={folderLabel(entry.path)}
          aside={formatRelative(new Date(entry.at))}
          current={entry.path === current}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  );
}

/** The drive's newest changes (agent-fs `recent`), one row per file, with who wrote it. */
export function RecentChangesList({ drive, current, limit = FULL_LIST, onNavigate }: ListProps) {
  const changes = useRecentChanges(drive, limit);
  const authorLabel = useAuthorLabel(drive);
  if (changes.isPending) return <ListSkeleton rows={Math.min(limit, 3)} />;
  if (changes.isError) {
    return isUnknownOpError(changes.error, "recent") ? (
      <ListNote>This agent-fs does not list changes.</ListNote>
    ) : (
      <ListNote tone="error">{changes.error.message}</ListNote>
    );
  }
  if (changes.data.length === 0) return <ListNote>No changes yet.</ListNote>;
  return (
    <ul aria-label="Recently changed" className="flex flex-col gap-px">
      {changes.data.map((change) => (
        <ListRow
          key={change.path}
          target={{ ...drive, path: change.path }}
          detail={`${folderLabel(change.path)} · ${authorLabel(change.author)}`}
          aside={formatRelative(change.at)}
          current={change.path === current}
          onNavigate={onNavigate}
        />
      ))}
    </ul>
  );
}

/**
 * The person's favorites on the drive (the header star), by name. Each row
 * can leave the list. They are the person's agent-fs stars
 * (`useCombFavorites`), so the agent-fs live UI shows the same list.
 */
export function FavoritesList({ drive, current, limit = Infinity, onNavigate }: ListProps) {
  const favorites = useCombFavorites(drive);
  if (favorites.isPending) return <ListSkeleton rows={2} />;
  if (favorites.error && !favorites.ids) {
    return <ListNote tone="error">{favorites.error.message}</ListNote>;
  }
  const pins = drivePins(favorites.ids ?? [], drive).slice(0, limit);
  if (pins.length === 0) return <ListNote>Star a file or folder to keep it here.</ListNote>;

  const remove = (pin: DrivePath) =>
    favorites.toggle(pin, false, {
      onError: () => toast.error("Could not remove the favorite."),
    });

  return (
    <ul aria-label="Favorites" className="flex flex-col gap-px">
      {pins.map((pin) => {
        const label = pinLabel(pin.path);
        return (
          <ListRow
            key={pin.path}
            target={pin}
            detail={pin.path === "/" ? "Drive root" : folderLabel(pin.path.replace(/\/$/, ""))}
            current={pin.path === current}
            onNavigate={onNavigate}
            actions={
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Actions for ${label}`}
                    className="mr-1 size-6 shrink-0 opacity-100 transition-opacity focus-visible:opacity-100 data-[state=open]:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={favorites.isToggling} onSelect={() => remove(pin)}>
                    <StarOff />
                    Remove from favorites
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
        );
      })}
    </ul>
  );
}

type RecentView = "viewed" | "changed";

const RECENT_VIEWS = [
  { value: "viewed", label: "Viewed", tooltip: "Files you opened in this browser" },
  { value: "changed", label: "Changed", tooltip: "Files anyone changed in the drive" },
] as const;

/** The left panel's Recent tab: Viewed (this browser) or Changed (the drive). */
export function RecentTab(props: Omit<ListProps, "limit">) {
  const [view, setView] = useState<RecentView>("viewed");
  return (
    <div className="flex flex-col gap-1.5 p-1.5">
      <SegmentedControl
        size="sm"
        aria-label="Recent files"
        value={view}
        onValueChange={setView}
        options={RECENT_VIEWS}
        className="flex w-full *:flex-1"
      />
      {view === "viewed" ? <RecentlyViewedList {...props} /> : <RecentChangesList {...props} />}
    </div>
  );
}

/** The left panel's Favorites tab. */
export function FavoritesTab(props: Omit<ListProps, "limit">) {
  return (
    <div className="p-1.5">
      <FavoritesList {...props} />
    </div>
  );
}
