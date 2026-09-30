import { ChevronRight, Folder, HardDrive } from "lucide-react";
import { Fragment } from "react";
import { Link } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  ancestorFolders,
  baseName,
  type CombLocation,
  combPath,
  type DrivePath,
  parentFolder,
} from "@/lib/comb/paths";
import { cn } from "@/lib/utils";

const TRAIL_LINK =
  "shrink-0 rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60";

/**
 * The folders that hold a file, as a short muted trail before its name. It
 * keeps the last folders (3 from `lg`, 2 from `sm`, none on phones). The
 * rest, with the drive root, sit behind "…": its tooltip shows the full path,
 * and its menu opens any of them.
 */
export function FolderTrail({ file }: { file: DrivePath }) {
  const lg = useMediaQuery("(min-width: 1024px)");
  const sm = useMediaQuery("(min-width: 640px)");
  const keep = lg ? 3 : sm ? 2 : 0;
  const folders = ancestorFolders(file.path);
  // The root is hidden only together with other folders.
  const cut = folders.length - 1 > keep ? folders.length - keep : 0;
  const hidden = folders.slice(0, cut);
  const shown = folders.slice(cut);
  const fullPath = parentFolder(file.path);

  return (
    <nav
      aria-label="Folders"
      className="flex min-w-0 shrink-0 items-center text-sm text-muted-foreground"
    >
      <ol className="flex items-center gap-1">
        {hidden.length > 0 ? (
          <li className="flex items-center gap-1">
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger
                    className={cn(TRAIL_LINK, "px-0.5")}
                    aria-label={`More folders: ${fullPath}`}
                  >
                    …
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="font-mono">
                  {fullPath}
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start">
                {hidden.map((path) => (
                  <DropdownMenuItem key={path} asChild>
                    <Link to={combPath({ ...file, path })}>
                      {path === "/" ? <HardDrive /> : <Folder />}
                      {path === "/" ? "Drive" : baseName(path)}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <span aria-hidden>/</span>
          </li>
        ) : null}
        {shown.map((path) => (
          <li key={path} className="flex items-center gap-1">
            <Link
              to={combPath({ ...file, path })}
              className={cn(TRAIL_LINK, "max-w-24 truncate sm:max-w-40")}
              aria-label={path === "/" ? "Drive" : undefined}
            >
              {path === "/" ? <HardDrive className="size-3.5" aria-hidden /> : baseName(path)}
            </Link>
            <span aria-hidden>/</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The path trail: the drive root, each folder, then the current file or folder. */
export function CombBreadcrumbs({ location }: { location: CombLocation }) {
  const folders = ancestorFolders(location.path);
  const crumbs = location.isFolder ? folders : [...folders, location.path];

  return (
    <nav aria-label="Path" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
        {crumbs.map((path, index) => {
          const isLast = index === crumbs.length - 1;
          const isRoot = path === "/";
          // Phones keep the drive root, the parent folder, and the name. The
          // parent keeps its width there: the header below repeats the name.
          const isParent = !isRoot && index === crumbs.length - 2;
          const collapse = !isRoot && !isLast && !isParent;
          // Phones show the drive icon only. Parent folders give up their width
          // before the current name does.
          const label = isRoot ? (
            <span className="flex items-center gap-1.5" title="Drive">
              <HardDrive className="size-3.5 shrink-0" aria-hidden />
              <span className="sr-only sm:not-sr-only">Drive</span>
            </span>
          ) : (
            baseName(path)
          );
          return (
            <Fragment key={path}>
              {index > 0 ? (
                <li aria-hidden className={cn("shrink-0", collapse && "max-sm:hidden")}>
                  <ChevronRight className="size-3" />
                </li>
              ) : null}
              <li
                className={cn(
                  isLast ? "min-w-0" : isRoot ? "shrink-0" : "min-w-0 max-w-48 shrink-[8]",
                  collapse && "max-sm:hidden",
                  isParent && "max-sm:max-w-16 max-sm:shrink-0",
                )}
              >
                {isLast ? (
                  <span aria-current="page" className="block truncate font-medium text-foreground">
                    {label}
                  </span>
                ) : (
                  <Link
                    to={combPath({ ...location, path })}
                    className="block truncate rounded-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    {label}
                  </Link>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
