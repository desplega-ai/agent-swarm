import {
  Check,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FolderOpen,
  Link,
  Link2,
  type LucideIcon,
  SquareArrowOutUpRight,
  Star,
  StarOff,
} from "lucide-react";
import {
  createContext,
  Fragment,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { isCombFavorite, useCombFavorites } from "@/api/hooks/use-comb-favorites";
import { downloadDriveFile } from "@/components/comb/file-actions";
import { ShareDialog } from "@/components/comb/share-dialog";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { drivePathToLiveUrl } from "@/lib/comb/links";
import { baseName, combPath, type DrivePath, isFolderPath } from "@/lib/comb/paths";
import { SHARE_LINKS_FEATURE } from "@/lib/comb/share";
import { cn } from "@/lib/utils";

// The file menu of a tree row or a folder row: a hover "..." button and a
// right click, one item list (like the agent-fs live UI). Dialogs that an item
// opens (Share) live in `FileDialogsProvider`, so they outlive the menu.

/** A dialog that a menu item opens. */
export type FileDialog = { kind: "share"; target: DrivePath };

const FileDialogsContext = createContext<((dialog: FileDialog) => void) | null>(null);

/** Holds the one dialog a file menu opened. Wrap the Comb page with it. */
export function FileDialogsProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<FileDialog | null>(null);
  const close = useCallback(() => setDialog(null), []);
  return (
    <FileDialogsContext.Provider value={setDialog}>
      {children}
      {dialog?.kind === "share" ? <ShareDialog file={dialog.target} onClose={close} /> : null}
    </FileDialogsContext.Provider>
  );
}

/** The drive path as people paste it: "/docs/plan.md", a folder with its "/". */
export function copyablePath(target: DrivePath): string {
  return target.path;
}

async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Could not copy. The browser blocked the clipboard.");
  }
}

interface MenuAction {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/** The menu's items in groups (a separator between groups). Runs only while a menu is open. */
function useFileMenuGroups(target: DrivePath): MenuAction[][] {
  const navigate = useNavigate();
  const { liveUrl, features } = useAgentFs();
  const { client } = useAgentFsAccess();
  const favorites = useCombFavorites(target);
  const openDialog = useContext(FileDialogsContext);
  const isFolder = isFolderPath(target.path);
  const href = combPath(target);
  const liveHref = liveUrl ? drivePathToLiveUrl(target, liveUrl) : null;

  const open: MenuAction[] = [
    {
      id: "open",
      label: "Open",
      icon: FolderOpen,
      onSelect: () => void navigate(href),
    },
    {
      id: "new-tab",
      label: "Open in new tab",
      icon: SquareArrowOutUpRight,
      onSelect: () => window.open(href, "_blank", "noopener,noreferrer"),
    },
  ];

  const share: MenuAction[] = [
    {
      id: "copy-link",
      label: "Copy link",
      icon: Link,
      onSelect: () => void copyText(`${window.location.origin}${href}`, "Link copied"),
    },
    {
      id: "copy-path",
      label: "Copy path",
      icon: Copy,
      onSelect: () => void copyText(copyablePath(target), "Path copied"),
    },
  ];
  if (!isFolder && openDialog && features.has(SHARE_LINKS_FEATURE)) {
    share.push({
      id: "share",
      label: "Share…",
      icon: Link2,
      onSelect: () => openDialog({ kind: "share", target }),
    });
  }
  if (target.path !== "/" && favorites.available) {
    const starred = isCombFavorite(favorites, target);
    share.push({
      id: "favorite",
      label: starred ? "Remove from favorites" : "Add to favorites",
      icon: starred ? StarOff : Star,
      disabled: !favorites.ids,
      onSelect: () =>
        favorites.toggle(target, !starred, {
          onError: () =>
            toast.error(starred ? "Could not remove the favorite." : "Could not add the favorite."),
        }),
    });
  }
  if (!isFolder && client) {
    share.push({
      id: "download",
      label: "Download",
      icon: Download,
      onSelect: () =>
        void downloadDriveFile(client, target).catch((err: unknown) =>
          toast.error(err instanceof Error ? err.message : "Download failed"),
        ),
    });
  }

  const elsewhere: MenuAction[] = liveHref
    ? [
        {
          id: "agent-fs",
          label: "Open in agent-fs",
          icon: ExternalLink,
          onSelect: () => window.open(liveHref, "_blank", "noopener,noreferrer"),
        },
      ]
    : [];

  return [open, share, elsewhere].filter((group) => group.length > 0);
}

/** The menu's items, as dropdown or context menu items. */
function FileMenuItems({ target, as }: { target: DrivePath; as: "dropdown" | "context" }) {
  const groups = useFileMenuGroups(target);
  const Item = as === "dropdown" ? DropdownMenuItem : ContextMenuItem;
  const Separator = as === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;
  return groups.map((group, index) => (
    <Fragment key={group[0]?.id ?? index}>
      {index > 0 ? <Separator /> : null}
      {group.map((action) => (
        <Item
          key={action.id}
          disabled={action.disabled}
          variant={action.destructive ? "destructive" : "default"}
          onSelect={action.onSelect}
        >
          <action.icon aria-hidden />
          {action.label}
        </Item>
      ))}
    </Fragment>
  ));
}

/**
 * The hover "..." button of a row. Mouse only (`tabIndex={-1}`): keyboard
 * users open the same menu with the context menu key on the row.
 */
export function FileMenuButton({ target, className }: { target: DrivePath; className?: string }) {
  const [open, setOpen] = useState(false);
  const name = baseName(target.path) || "Drive";
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          tabIndex={-1}
          aria-label={`More actions for ${name}`}
          // A click on the button must not reach the row link.
          onClick={(event: MouseEvent) => event.stopPropagation()}
          className={cn(
            "size-6 shrink-0 text-muted-foreground hover:text-foreground data-[state=open]:opacity-100",
            className,
          )}
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="min-w-48">
        <FileMenuItems target={target} as="dropdown" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The right-click menu around `children`. `target` is the row's path, or
 * `pick` finds it from the clicked element (one menu for a whole grid). No
 * target: the browser's own menu shows.
 */
export function FileContextMenu({
  target,
  pick,
  children,
}: {
  target?: DrivePath;
  pick?: (element: Element) => DrivePath | null;
  children: ReactNode;
}) {
  const [picked, setPicked] = useState<DrivePath | null>(null);
  const current = target ?? picked;
  const onContextMenu = useMemo(
    () =>
      pick
        ? (event: MouseEvent) => {
            const next = pick(event.target as Element);
            setPicked(next);
            // Nothing under the pointer: no Comb menu, so Radix does not open.
            if (!next) event.stopPropagation();
          }
        : undefined,
    [pick],
  );
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenuCapture={onContextMenu}>
        {children}
      </ContextMenuTrigger>
      {current ? (
        <ContextMenuContent className="min-w-48">
          <FileMenuItems target={current} as="context" />
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}

/** A header icon button that copies the drive path ("/docs/plan.md"). */
export function CopyPathButton({ target }: { target: DrivePath }) {
  const { copied, copy } = useCopyToClipboard();
  // One width: only the icon changes, and the label says "Path copied".
  const label = copied ? "Path copied" : "Copy path";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          onClick={async () => {
            if (!(await copy(copyablePath(target)))) {
              toast.error("Could not copy. The browser blocked the clipboard.");
            }
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
