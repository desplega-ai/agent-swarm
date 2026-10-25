import {
  Check,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Link,
  Link2,
  type LucideIcon,
  Pencil,
  Plus,
  SquareArrowOutUpRight,
  Star,
  StarOff,
  Trash2,
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
import { DeleteDialog, NewEntryDialog, RenameDialog } from "@/components/comb/file-dialogs";
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

// The file menu of a tree row, a folder row, or the file header: a "..."
// button and a right click, one item list (like the agent-fs live UI).
// Dialogs that an item opens live in `FileDialogsProvider`, so they outlive
// the menu.

/** A dialog that a menu item opens. */
export type FileDialog = {
  kind: "share" | "new-file" | "new-folder" | "rename" | "delete";
  target: DrivePath;
};

const FileDialogsContext = createContext<((dialog: FileDialog) => void) | null>(null);

/** Opens a file dialog. Null outside `FileDialogsProvider`. */
export function useFileDialogs(): ((dialog: FileDialog) => void) | null {
  return useContext(FileDialogsContext);
}

/**
 * Holds the one dialog a file menu opened. Wrap the Comb page with it.
 * `current` is the path the page shows: renaming or deleting it moves the page.
 */
export function FileDialogsProvider({
  current,
  children,
}: {
  current: string;
  children: ReactNode;
}) {
  const [dialog, setDialog] = useState<FileDialog | null>(null);
  const close = useCallback(() => setDialog(null), []);
  return (
    <FileDialogsContext.Provider value={setDialog}>
      {children}
      {dialog?.kind === "share" ? <ShareDialog file={dialog.target} onClose={close} /> : null}
      {dialog?.kind === "new-file" || dialog?.kind === "new-folder" ? (
        <NewEntryDialog
          kind={dialog.kind === "new-file" ? "file" : "folder"}
          folder={dialog.target}
          onClose={close}
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <RenameDialog file={dialog.target} current={current} onClose={close} />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteDialog file={dialog.target} current={current} onClose={close} />
      ) : null}
    </FileDialogsContext.Provider>
  );
}

const CLIPBOARD_BLOCKED = "Could not copy. The browser blocked the clipboard.";

/** Copy from a menu item. The menu closes at once, so a toast says it worked. */
async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error(CLIPBOARD_BLOCKED);
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
      // The drive path as people paste it: "/docs/plan.md", a folder with its "/".
      onSelect: () => void copyText(target.path, "Path copied"),
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

  // Write actions, as in the live UI: new entries in a folder, rename and delete for a file.
  const edit: MenuAction[] = [];
  if (openDialog && isFolder) {
    edit.push(
      {
        id: "new-file",
        label: "New file…",
        icon: FilePlus,
        onSelect: () => openDialog({ kind: "new-file", target }),
      },
      {
        id: "new-folder",
        label: "New folder…",
        icon: FolderPlus,
        onSelect: () => openDialog({ kind: "new-folder", target }),
      },
    );
  }
  if (openDialog && !isFolder) {
    edit.push(
      {
        id: "rename",
        label: "Rename…",
        icon: Pencil,
        onSelect: () => openDialog({ kind: "rename", target }),
      },
      {
        id: "delete",
        label: "Delete…",
        icon: Trash2,
        destructive: true,
        onSelect: () => openDialog({ kind: "delete", target }),
      },
    );
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

  return [open, share, edit, elsewhere].filter((group) => group.length > 0);
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
export function FileMenuButton({
  target,
  className,
  header = false,
}: {
  target: DrivePath;
  className?: string;
  /** The file header's button: a keyboard stop, icon size, a menu below it. */
  header?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const name = baseName(target.path) || "Drive";
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size={header ? "icon-sm" : "icon"}
          tabIndex={header ? undefined : -1}
          aria-label={header ? "More actions" : `More actions for ${name}`}
          // A click on the button must not reach the row link.
          onClick={(event: MouseEvent) => event.stopPropagation()}
          className={cn(
            !header && "size-6 shrink-0",
            "text-muted-foreground hover:text-foreground data-[state=open]:opacity-100",
            className,
          )}
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={header ? "end" : "start"}
        side={header ? "bottom" : "right"}
        className="min-w-48"
      >
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
            if (!(await copy(target.path))) toast.error(CLIPBOARD_BLOCKED);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** The folder header's New menu: New file and New folder in `folder`. */
export function NewEntryButton({ folder }: { folder: DrivePath }) {
  const openDialog = useFileDialogs();
  if (!openDialog) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" aria-label="New">
          <Plus />
          <span className="hidden sm:inline">New</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuItem onSelect={() => openDialog({ kind: "new-file", target: folder })}>
          <FilePlus aria-hidden />
          New file…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog({ kind: "new-folder", target: folder })}>
          <FolderPlus aria-hidden />
          New folder…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
