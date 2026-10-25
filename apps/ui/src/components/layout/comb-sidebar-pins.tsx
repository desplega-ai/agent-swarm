import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useCombFavorites } from "@/api/hooks/use-comb-favorites";
import type { StatusComb } from "@/api/types";
import { FileKindIcon } from "@/components/comb/file-icon";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { MiddleTruncation } from "@/components/ui/middle-truncation";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "@/components/ui/sidebar";
import { combPath, isFolderPath, pinLabel, sidebarPins } from "@/lib/comb/paths";

/**
 * The swarm drive's favorites under the sidebar's Comb item. The "Favorites" header
 * folds them like the WORK / SWARM / RESOURCES groups, and the state stays in
 * localStorage. A long list shows the newest pins and a "Show all" row.
 * Renders nothing while the drive has no pins. The icon-collapsed sidebar
 * shows no pins: the Comb icon leads to the full Favorites tab.
 */
export function CombSidebarPins({ comb }: { comb: StatusComb | undefined }) {
  const { pathname } = useLocation();
  const [showAll, setShowAll] = useState(false);
  const drive =
    comb?.org_id && comb.drive_id ? { orgId: comb.org_id, driveId: comb.drive_id } : null;
  const favorites = useCombFavorites(drive);
  if (!drive) return null;

  const { pins, total, foldable } = sidebarPins(favorites.ids ?? [], drive, showAll);
  if (total === 0) return null;

  return (
    <CollapsibleSection
      title="Favorites"
      defaultOpen
      persistKey="agent-swarm:sidebar-group:comb-pins"
      // Puts the chevron under the Comb icon, on top of the list's guide line.
      className="mt-1 pl-2.5"
    >
      <SidebarMenuSub className="mx-1">
        {pins.map((pin) => {
          const to = combPath(pin);
          const label = pinLabel(pin.path);
          const active = pathname === to;
          return (
            <SidebarMenuSubItem key={pin.path}>
              <SidebarMenuSubButton
                asChild
                isActive={active}
                className="text-sidebar-foreground/70 transition-colors hover-linger [&>svg]:text-muted-foreground"
              >
                <Link
                  to={to}
                  // The visible label can be cut in the middle.
                  aria-label={label}
                  aria-current={active ? "page" : undefined}
                  title={pin.path}
                >
                  <FileKindIcon name={label} isFolder={isFolderPath(pin.path)} />
                  <MiddleTruncation title={undefined}>{label}</MiddleTruncation>
                </Link>
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          );
        })}
        {foldable && (
          <SidebarMenuSubItem>
            <SidebarMenuSubButton
              asChild
              size="sm"
              className="text-muted-foreground transition-colors hover-linger"
            >
              <button type="button" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
                {showAll ? "Show fewer" : `Show all ${total}`}
              </button>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        )}
      </SidebarMenuSub>
    </CollapsibleSection>
  );
}
