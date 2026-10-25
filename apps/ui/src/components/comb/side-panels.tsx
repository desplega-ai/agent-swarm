import {
  CloudOff,
  FolderTree,
  History,
  type LucideIcon,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Star,
  TableOfContents,
} from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LEFT_TABS, type LeftTab, RIGHT_TABS, type RightTab } from "@/lib/comb/panels";
import type { CombLocation } from "@/lib/comb/paths";
import { usePageShortcut } from "@/lib/json-render/use-page-shortcut";
import { cn } from "@/lib/utils";
import { useCombLayout } from "./comb-layout";
import { OutlineList } from "./outline-list";
import { FavoritesTab, RecentTab } from "./recent-lists";
import { TreeRail } from "./tree-rail";

// Drive-style side panels. Open, a panel is a card with a title row and a
// collapse button. Collapsed, it is a thin strip of icon buttons: a toggle,
// then one button per tab. The panel body stays mounted while collapsed, so
// the tree keeps its open folders and the comments keep their state.

const PANEL_CARD = "overflow-hidden rounded-xl border border-border bg-card";
const STRIP = "w-11 items-center gap-1 py-1";

function PanelButton({
  label,
  icon: Icon,
  onClick,
  side,
  buttonRef,
  className,
  children,
}: {
  label: string;
  icon: LucideIcon;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Where the tooltip opens. */
  side: "left" | "right" | "bottom";
  buttonRef?: RefObject<HTMLButtonElement | null>;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={buttonRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
          className={cn("relative text-muted-foreground hover:text-foreground", className)}
        >
          <Icon />
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Keyboard focus follows the toggle: collapsing moves it to the strip,
 * expanding moves it into the panel (`expandTarget`). A panel that closes on
 * its own (the drive root) also hands keyboard focus to the strip.
 * Pointer focus stays put, so no tooltip pops up after a click.
 */
function usePanelFocus(open: boolean) {
  const panelRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLButtonElement>(null);
  // Set by a keyboard toggle: where focus goes once the panel opens.
  const expandTarget = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    if (open) {
      expandTarget.current?.focus();
      expandTarget.current = null;
      return;
    }
    const focused = document.activeElement;
    if (panelRef.current?.contains(focused) && focused?.matches(":focus-visible")) {
      stripRef.current?.focus();
    }
  }, [open]);
  return { panelRef, stripRef, expandTarget };
}

/** A keyboard press on a button fires a click with no pointer detail. */
function fromKeyboard(event: MouseEvent<HTMLElement>): boolean {
  return event.detail === 0;
}

const TAB_LABEL: Record<LeftTab, string> = {
  files: "Files",
  recent: "Recent",
  favorites: "Favorites",
};
const TAB_ICON: Record<LeftTab, LucideIcon> = {
  files: FolderTree,
  recent: History,
  favorites: Star,
};

/**
 * The left panel beside the content: Files (the drive tree), Recent (viewed
 * and changed files), and Favorites.
 */
export function LeftPanel({ location }: { location: CombLocation }) {
  const layout = useCombLayout();
  const { panelRef, stripRef, expandTarget } = usePanelFocus(layout?.left.open ?? true);
  if (!layout) return null;
  const { left, showLeft, collapseLeft } = layout;
  const show = (tab: LeftTab, event: MouseEvent<HTMLElement>) => {
    if (fromKeyboard(event)) {
      expandTarget.current =
        panelRef.current?.querySelector<HTMLElement>(`[data-panel-tab="${tab}"]`) ?? null;
    }
    showLeft(tab);
  };

  return (
    <aside
      aria-label="Files panel"
      className={cn("flex shrink-0 flex-col", left.open ? `w-64 ${PANEL_CARD}` : STRIP)}
    >
      {left.open ? null : (
        <>
          <PanelButton
            label="Expand panel"
            icon={PanelLeftOpen}
            side="right"
            buttonRef={stripRef}
            onClick={(event) => show(left.tab, event)}
          />
          <span aria-hidden className="my-0.5 h-px w-5 bg-border" />
          {LEFT_TABS.map((tab) => (
            <PanelButton
              key={tab}
              label={TAB_LABEL[tab]}
              icon={TAB_ICON[tab]}
              side="right"
              onClick={(event) => show(tab, event)}
              className={tab === left.tab ? "text-foreground" : undefined}
            />
          ))}
        </>
      )}
      <div ref={panelRef} hidden={!left.open} className="flex min-h-0 flex-1 flex-col">
        <LeftPanelBody
          location={location}
          action={
            <PanelButton
              label="Collapse panel"
              icon={PanelLeftClose}
              side="bottom"
              onClick={() => collapseLeft()}
            />
          }
        />
      </div>
    </aside>
  );
}

/** The tabs and their content, shared by the inline panel and the phone sheet. */
function LeftPanelBody({
  location,
  action,
  onNavigate,
  titleRowClassName,
}: {
  location: CombLocation;
  /** The collapse button (inline panel only). */
  action?: ReactNode;
  /** A row opened a file or a heading (the phone sheet closes). */
  onNavigate?: () => void;
  titleRowClassName?: string;
}) {
  const layout = useCombLayout();
  if (!layout) return null;
  const { left, selectLeft } = layout;
  return (
    <Tabs
      value={left.tab}
      onValueChange={(tab) => selectLeft(tab as LeftTab)}
      className="min-h-0 flex-1 gap-0"
    >
      <div
        className={cn(
          "flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle pr-1 pl-1.5",
          titleRowClassName,
        )}
      >
        {/* Icons, with the name of the open tab: three names do not fit the panel. */}
        <TabsList variant="line" className="p-0 group-data-[orientation=horizontal]/tabs:h-full">
          {LEFT_TABS.map((tab) => {
            const Icon = TAB_ICON[tab];
            const active = tab === left.tab;
            return (
              <Tooltip key={tab}>
                <TooltipTrigger asChild>
                  <TabsTrigger
                    value={tab}
                    data-panel-tab={tab}
                    aria-label={TAB_LABEL[tab]}
                    className={LINE_TAB}
                  >
                    <Icon aria-hidden />
                    {active ? TAB_LABEL[tab] : null}
                  </TabsTrigger>
                </TooltipTrigger>
                {active ? null : <TooltipContent side="bottom">{TAB_LABEL[tab]}</TooltipContent>}
              </Tooltip>
            );
          })}
        </TabsList>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {/* Both stay mounted: the tree keeps its open folders across tab switches. */}
      <TabsContent
        value="files"
        forceMount
        className="min-h-0 overflow-y-auto data-[state=inactive]:hidden"
      >
        <TreeRail
          key={`${location.orgId}/${location.driveId}`}
          location={location}
          onNavigate={onNavigate}
        />
      </TabsContent>
      <TabsContent value="recent" className="min-h-0 overflow-y-auto">
        <RecentTab drive={location} current={location.path} onNavigate={onNavigate} />
      </TabsContent>
      <TabsContent value="favorites" className="min-h-0 overflow-y-auto">
        <FavoritesTab drive={location} current={location.path} onNavigate={onNavigate} />
      </TabsContent>
    </Tabs>
  );
}

// Line tabs whose underline sits on the title row's bottom rule.
const LINE_TAB =
  "h-full flex-none px-2 group-data-[orientation=horizontal]/tabs:after:bottom-[-1px]";

/** Below `md`: the left panel opens in a sheet from a header button. */
export function LeftPanelSheet({ location }: { location: CombLocation }) {
  const [open, setOpen] = useState(false);
  const navigated = useRef(false);
  const label = "Show the files panel";
  // The files icon: a panel icon is the top bar's sidebar button, and the
  // Recent icon is the versions button next to it.
  const Icon = FolderTree;
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={label} className="shrink-0">
              <Icon />
            </Button>
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <SheetContent
        side="left"
        className="w-72 gap-0 p-0"
        aria-describedby={undefined}
        // A row or a heading moved the page: focus does not go back to the
        // trigger, so its tooltip does not open over the file.
        onCloseAutoFocus={(event) => {
          if (!navigated.current) return;
          navigated.current = false;
          event.preventDefault();
        }}
      >
        <SheetTitle className="sr-only">Files panel</SheetTitle>
        <div className="flex min-h-0 flex-1 flex-col pt-1">
          {/* The sheet's close button sits at the title row's right end. */}
          <LeftPanelBody
            location={location}
            onNavigate={() => {
              navigated.current = true;
              setOpen(false);
            }}
            titleRowClassName="pr-12"
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}

const RIGHT_LABEL: Record<RightTab, string> = { comments: "Comments", outline: "Outline" };

/**
 * The right panel's title row and tabs, shared by the inline panel and the
 * phone sheet: Comments, and Outline for a file with headings (one title
 * without tabs otherwise). The comments stay mounted on the Outline tab, so
 * the rail keeps its filters and drafts.
 */
export function RightPanelBody({
  comments,
  count,
  action,
  onNavigate,
  titleRowClassName,
}: {
  /** The comment rail. */
  comments: ReactNode;
  /** Open comments plus unsaved ones, next to the Comments tab name. */
  count: number;
  /** The collapse button (inline panel only). */
  action?: ReactNode;
  /** A heading moved the page (the phone sheet closes). */
  onNavigate?: () => void;
  titleRowClassName?: string;
}) {
  const layout = useCombLayout();
  const outline = layout?.right.outline ?? false;
  const tab = layout?.right.tab ?? "comments";
  const titleRow = cn(
    "flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle pr-1",
    titleRowClassName,
  );
  if (!layout || !outline) {
    return (
      <>
        <div className={cn(titleRow, "pl-3.5")}>
          <h2 className="text-sm font-medium">Comments</h2>
          {action ? <div className="ml-auto">{action}</div> : null}
        </div>
        {comments}
      </>
    );
  }
  return (
    <Tabs
      value={tab}
      onValueChange={(next) => layout.selectRight(next as RightTab)}
      className="min-h-0 flex-1 gap-0"
    >
      <div className={cn(titleRow, "pl-1.5")}>
        <TabsList variant="line" className="p-0 group-data-[orientation=horizontal]/tabs:h-full">
          {RIGHT_TABS.map((value) => {
            const Icon = value === "comments" ? MessageSquare : TableOfContents;
            return (
              <TabsTrigger key={value} value={value} data-panel-tab={value} className={LINE_TAB}>
                <Icon aria-hidden />
                {RIGHT_LABEL[value]}
                {value === "comments" && count > 0 ? (
                  <span className="text-muted-foreground tabular-nums">{count}</span>
                ) : null}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      <TabsContent
        value="comments"
        forceMount
        className="flex min-h-0 flex-col data-[state=inactive]:hidden"
      >
        {comments}
      </TabsContent>
      <TabsContent value="outline" className="min-h-0 overflow-y-auto">
        <OutlineList onNavigate={onNavigate} />
      </TabsContent>
    </Tabs>
  );
}

/**
 * The right panel from `md` up: Comments and Outline with a title row and a
 * collapse button, or a strip with the comment count (and Outline). A
 * `?comment=` link (a deep link, or a click on a highlighted passage) opens
 * the panel on Comments.
 */
export function CommentPanel({
  openCount,
  notSaved,
  children,
}: {
  openCount: number;
  notSaved: number;
  children: ReactNode;
}) {
  const layout = useCombLayout();
  const open = layout?.right.open ?? true;
  const { panelRef, stripRef, expandTarget } = usePanelFocus(open);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const [searchParams] = useSearchParams();
  const linkedId = searchParams.get("comment");

  // Only a new link opens the panel: collapsing with a link in the URL stays collapsed.
  const showRight = layout?.showRight;
  const lastLinked = useRef<string | null>(null);
  useEffect(() => {
    if (linkedId === lastLinked.current) return;
    lastLinked.current = linkedId;
    if (linkedId) showRight?.("comments");
  }, [linkedId, showRight]);

  const total = openCount + notSaved;
  const label = `Comments (${openCount} open${notSaved ? `, ${notSaved} not saved` : ""})`;
  const expand = (tab: RightTab, event: MouseEvent<HTMLElement>) => {
    if (fromKeyboard(event)) expandTarget.current = collapseRef.current;
    layout?.showRight(tab);
  };

  return (
    <aside
      aria-label={layout?.right.outline ? "Comments and outline" : "Comments"}
      className={cn("flex shrink-0 flex-col", open ? `w-72 xl:w-80 ${PANEL_CARD}` : STRIP)}
    >
      {open ? null : (
        <>
          <PanelButton
            label="Expand panel"
            icon={PanelRightOpen}
            side="left"
            buttonRef={stripRef}
            onClick={(event) => expand(layout?.right.tab ?? "comments", event)}
          />
          <span aria-hidden className="my-0.5 h-px w-5 bg-border" />
          <PanelButton
            label={label}
            icon={notSaved ? CloudOff : MessageSquare}
            side="left"
            onClick={(event) => expand("comments", event)}
            className={notSaved ? "[&_svg]:text-status-error-strong" : undefined}
          >
            {total > 0 ? (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 font-medium text-[10px] text-foreground tabular-nums ring-2 ring-background">
                {total}
              </span>
            ) : null}
          </PanelButton>
          {layout?.right.outline ? (
            <PanelButton
              label="Outline"
              icon={TableOfContents}
              side="left"
              onClick={(event) => expand("outline", event)}
            />
          ) : null}
        </>
      )}
      <div ref={panelRef} hidden={!open} className="flex min-h-0 flex-1 flex-col">
        <RightPanelBody
          comments={children}
          count={total}
          action={
            layout ? (
              <PanelButton
                label="Collapse panel"
                icon={PanelRightClose}
                side="bottom"
                buttonRef={collapseRef}
                onClick={() => layout.collapseRight()}
              />
            ) : null
          }
        />
      </div>
    </aside>
  );
}

/**
 * The header's full width toggle (`F`): a markdown file's text runs as wide
 * as its pane. The side panels stay. Only on a markdown file, from `md` up
 * (narrower panes are already under the reading measure).
 */
export function FullWidthButton() {
  const layout = useCombLayout();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const on = layout?.fullWidth ?? false;
  const setFullWidth = layout?.setFullWidth;
  const shown = layout?.inline && layout.canWiden;
  usePageShortcut(shown ? "f" : undefined, buttonRef, () => setFullWidth?.(!on));
  if (!shown) return null;
  const label = on ? "Exit full width" : "Full width";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={buttonRef}
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={on}
          aria-keyshortcuts="F"
          onClick={() => layout.setFullWidth(!on)}
        >
          {on ? <Minimize2 /> : <Maximize2 />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex items-center gap-1.5">
        {label} <Kbd aria-hidden>F</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}
