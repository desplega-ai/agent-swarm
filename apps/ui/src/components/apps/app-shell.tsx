/**
 * App shell for `layout: "sidebar"` swarm apps: a left sidebar listing the
 * app's pages and a sticky page header (title, description, actions slot)
 * over the scrolling page body. Below `md` the sidebar folds into a menu
 * button in the header. The runtime (`app-surface.tsx`) owns routing; this
 * file is layout only.
 */

import { LayoutGrid, Menu } from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { AppPageDef } from "@/api/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { catalogIcon } from "@/lib/json-render/icons";
import { useJsonRenderThemeAttr } from "@/lib/json-render/theme-scope";
import { cn } from "@/lib/utils";

export interface ShellNavItem {
  name: string;
  title: string;
  icon?: string;
  href: string;
}

/**
 * Pages the sidebar lists, in definition order: every page except `nav: false`
 * ones and pages with a required param (they cannot open without one).
 */
export function shellNavItems(
  pages: Record<string, AppPageDef>,
  hrefFor: (page: string) => string,
): ShellNavItem[] {
  return Object.entries(pages)
    .filter(
      ([, page]) =>
        page.nav !== false && !Object.values(page.params ?? {}).some((param) => param.required),
    )
    .map(([name, page]) => ({
      name,
      title: page.title ?? name,
      icon: page.icon,
      href: hrefFor(name),
    }));
}

function isPlainLeftClick(event: React.MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function AppShell({
  items,
  activePage,
  onNavigate,
  appName,
  title,
  description,
  crumbs,
  actions,
  surfaceClass,
  scrollRef,
  children,
}: {
  items: ShellNavItem[];
  activePage: string;
  onNavigate: (href: string) => void;
  /** Shown atop the sidebar where the dashboard header is absent (full, chromeless). */
  appName?: string;
  title: string;
  description?: string;
  crumbs?: ReactNode;
  actions?: ReactNode;
  /** Background of the canvas, repeated on the sticky header so content scrolls under it. */
  surfaceClass: string;
  scrollRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const themeAttr = useJsonRenderThemeAttr();
  const link = (item: ShellNavItem, className: string) => {
    const Icon = catalogIcon(item.icon) ?? LayoutGrid;
    const active = item.name === activePage;
    return (
      <a
        key={item.name}
        href={item.href}
        aria-current={active ? "page" : undefined}
        onClick={(event) => {
          // Plain click routes in-app; modified clicks keep the browser's new-tab behavior.
          if (!isPlainLeftClick(event)) return;
          event.preventDefault();
          onNavigate(item.href);
        }}
        className={cn(
          className,
          active
            ? "bg-muted font-medium text-foreground"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        )}
      >
        <Icon aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{item.title}</span>
      </a>
    );
  };

  return (
    <div className="flex min-h-0 flex-1" data-testid="app-shell">
      <nav
        aria-label="App pages"
        className="hidden w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2 md:flex"
        data-testid="app-shell-sidebar"
      >
        {appName ? (
          <p className="truncate px-2 pt-1 pb-2 text-sm font-semibold">{appName}</p>
        ) : null}
        {items.map((item) =>
          link(item, "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors"),
        )}
      </nav>
      <div ref={scrollRef} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header
          className={cn(
            "sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border px-4 py-3",
            surfaceClass,
          )}
          data-testid="app-shell-header"
        >
          <div className="flex min-w-0 items-start gap-2">
            {items.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-8 shrink-0 md:hidden"
                    aria-label="App pages"
                  >
                    <Menu className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-48" {...themeAttr}>
                  {items.map((item) => {
                    const Icon = catalogIcon(item.icon) ?? LayoutGrid;
                    return (
                      <DropdownMenuItem
                        key={item.name}
                        onSelect={() => onNavigate(item.href)}
                        className={cn(item.name === activePage && "bg-muted font-medium")}
                        aria-current={item.name === activePage ? "page" : undefined}
                      >
                        <Icon aria-hidden className="size-4" />
                        {item.title}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
            <div className="min-w-0">
              {crumbs}
              <h2 className="truncate text-base font-semibold leading-8">{title}</h2>
              {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
            </div>
          </div>
          {actions ? (
            <div className="flex shrink-0 items-center gap-2" data-testid="app-shell-actions">
              {actions}
            </div>
          ) : null}
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4">{children}</div>
      </div>
    </div>
  );
}
