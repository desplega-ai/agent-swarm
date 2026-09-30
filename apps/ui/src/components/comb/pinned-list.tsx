import { Ellipsis, File, Folder, PinOff } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useFavorites, useFavoriteToggle } from "@/api/hooks/use-favorites";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MiddleTruncation } from "@/components/ui/middle-truncation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  type CombLocation,
  combPath,
  drivePins,
  isFolderPath,
  pinIdFor,
  pinLabel,
} from "@/lib/comb/paths";
import { cn } from "@/lib/utils";

/**
 * The pinned files and folders of the drive in `location`, above the tree.
 * Renders nothing while the drive has no pins.
 */
export function PinnedList({
  location,
  onNavigate,
}: {
  location: CombLocation;
  onNavigate?: () => void;
}) {
  const headingId = useId();
  const favorites = useFavorites("agent-fs-path");
  const toggle = useFavoriteToggle("agent-fs-path");
  const pins = drivePins(favorites.data?.favoriteIds ?? [], location);
  if (pins.length === 0) return null;

  const unpin = (itemId: string) =>
    toggle.mutate({ itemId, favorite: false }, { onError: () => toast.error("Could not unpin.") });

  return (
    <section aria-labelledby={headingId} className="border-b border-border p-1.5">
      <h3 id={headingId} className="px-2 pt-0.5 pb-1 text-xs font-medium text-muted-foreground">
        Pinned
      </h3>
      <ul className="flex flex-col gap-px text-sm">
        {pins.map((pin) => {
          const label = pinLabel(pin.path);
          const selected = pin.path === location.path;
          const Icon = isFolderPath(pin.path) ? Folder : File;
          return (
            <li
              key={pin.path}
              className={cn(
                "group hover-linger flex items-center rounded-md pr-1 transition-colors hover:bg-accent/50",
                selected && "bg-accent font-medium text-foreground",
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    to={combPath(pin)}
                    // The visible label can be cut in the middle.
                    aria-label={label}
                    aria-current={selected ? "page" : undefined}
                    onClick={onNavigate}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 pl-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {/* The tooltip shows the full path, so no native title. */}
                    <MiddleTruncation title={undefined}>{label}</MiddleTruncation>
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="right">{pin.path}</TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Actions for ${label}`}
                    className="size-6 opacity-100 transition-opacity focus-visible:opacity-100 data-[state=open]:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  >
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={toggle.isPending}
                    onSelect={() => unpin(pinIdFor(pin))}
                  >
                    <PinOff />
                    Unpin
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
