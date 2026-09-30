import { ChevronRight, HardDrive } from "lucide-react";
import { Fragment } from "react";
import { Link } from "react-router-dom";
import { ancestorFolders, baseName, type CombLocation, combPath } from "@/lib/comb/paths";

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
                <li aria-hidden className="shrink-0">
                  <ChevronRight className="size-3" />
                </li>
              ) : null}
              <li
                className={isLast ? "min-w-0" : isRoot ? "shrink-0" : "min-w-0 max-w-48 shrink-[8]"}
              >
                {isLast ? (
                  <span aria-current="page" className="block truncate font-medium text-foreground">
                    {label}
                  </span>
                ) : (
                  <Link
                    to={combPath({ ...location, path })}
                    className="block truncate transition-colors hover:text-foreground"
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
