import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentFsStat, useAgentFsText } from "@/api/hooks/use-agent-fs";
import { useConfig } from "@/hooks/use-config";
import { useMediaQuery } from "@/hooks/use-media-query";
import { browserStorage } from "@/lib/comb/drafts";
import { getFileKind } from "@/lib/comb/file-kinds";
import { extractOutline, hasOutline, type OutlineHeading } from "@/lib/comb/outline";
import {
  LEFT_OPEN_QUERY,
  type LeftPanelEvent,
  type LeftPanelView,
  type LeftTab,
  leftPanelReducer,
  leftPanelView,
  PANELS_INLINE_QUERY,
  type PanelTarget,
  RIGHT_OPEN_QUERY,
  readLeftPanel,
  readRightPanel,
  rightPanelOpen,
  writeLeftPanel,
  writeRightPanel,
} from "@/lib/comb/panels";
import type { CombLocation, DrivePath } from "@/lib/comb/paths";

/** The Comb page layout: both side panels, the current file's outline, and its viewer pane. */
export interface CombLayoutValue {
  /** From `md` up the panels sit beside the content. Below that they are sheets. */
  inline: boolean;
  left: LeftPanelView;
  right: { open: boolean };
  /** Open the left panel on a tab (a strip button). */
  showLeft: (tab: LeftTab) => void;
  /** Pick a tab and leave the open state alone (the panel tabs, the phone sheet). */
  selectLeft: (tab: LeftTab) => void;
  collapseLeft: () => void;
  showRight: () => void;
  collapseRight: () => void;
  /** The current file's headings (empty for a folder and for a file with no outline). */
  headings: readonly OutlineHeading[];
  /** The current file's viewer scroll pane (the outline scrolls it). */
  viewer: HTMLElement | null;
  setViewer: (element: HTMLElement | null) => void;
}

const CombLayoutContext = createContext<CombLayoutValue | null>(null);

/** The layout, or null outside a Comb page. */
export function useCombLayout(): CombLayoutValue | null {
  return useContext(CombLayoutContext);
}

const NO_HEADINGS: readonly OutlineHeading[] = [];

interface OutlineResult {
  /** The location the result is for. */
  key: string;
  target: PanelTarget;
  headings: readonly OutlineHeading[];
}

function locationKey({ orgId, driveId, path }: DrivePath): string {
  return `${orgId}/${driveId}:${path}`;
}

/**
 * Holds the panel state for one swarm (key it by the API URL). The left panel
 * follows the route: see `leftPanelReducer`.
 */
export function CombLayoutProvider({
  location,
  children,
}: {
  location: CombLocation;
  children: ReactNode;
}) {
  const { apiUrl } = useConfig().config;
  const inline = useMediaQuery(PANELS_INLINE_QUERY);
  const leftWide = useMediaQuery(LEFT_OPEN_QUERY);
  const rightWide = useMediaQuery(RIGHT_OPEN_QUERY);

  const [left, setLeft] = useState(() => readLeftPanel(browserStorage(), apiUrl));
  const [rightStored, setRightStored] = useState(() => readRightPanel(browserStorage(), apiUrl));
  const [viewer, setViewer] = useState<HTMLElement | null>(null);
  const [outline, setOutline] = useState<OutlineResult | null>(null);

  const apply = useCallback(
    (event: LeftPanelEvent) => setLeft((state) => leftPanelReducer(state, event)),
    [],
  );

  // Store the open state and the tab when they change (never the auto collapse).
  const stored = useRef(`${left.open}:${left.tab}`);
  useEffect(() => {
    const next = `${left.open}:${left.tab}`;
    if (next === stored.current) return;
    stored.current = next;
    writeLeftPanel(browserStorage(), apiUrl, { open: left.open, tab: left.tab });
  }, [apiUrl, left.open, left.tab]);

  // What the route shows. A file is pending until its kind (and, for
  // markdown, its headings) is known. The view keeps the last target
  // meanwhile, so the tab does not flash while the next file loads.
  const key = locationKey(location);
  const resolved: PanelTarget | "pending" = location.isFolder
    ? "folder"
    : outline?.key === key
      ? outline.target
      : "pending";
  const [target, setTarget] = useState<PanelTarget>(location.isFolder ? "folder" : "plain");
  const navigated = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (resolved === "pending") return;
    setTarget(resolved);
    // Once per route: a new version that adds or drops headings does not move the panel.
    if (navigated.current === key) return;
    apply({ type: "navigate", target: resolved, first: navigated.current === null });
    navigated.current = key;
  }, [key, resolved, apply]);

  const value = useMemo<CombLayoutValue>(
    () => ({
      inline,
      left: leftPanelView(left, target, leftWide),
      right: { open: rightPanelOpen(rightStored, rightWide) },
      showLeft: (tab) => apply({ type: "show", tab, target }),
      selectLeft: (tab) => apply({ type: "select", tab, target }),
      collapseLeft: () => apply({ type: "collapse" }),
      showRight: () => {
        setRightStored(true);
        writeRightPanel(browserStorage(), apiUrl, true);
      },
      collapseRight: () => {
        setRightStored(false);
        writeRightPanel(browserStorage(), apiUrl, false);
      },
      headings:
        outline?.key === key && outline.target === "outline" ? outline.headings : NO_HEADINGS,
      viewer,
      setViewer,
    }),
    [inline, left, target, leftWide, rightStored, rightWide, apply, apiUrl, outline, key, viewer],
  );

  return (
    <CombLayoutContext.Provider value={value}>
      {location.isFolder ? null : (
        <OutlineProbe key={key} file={location} probeKey={key} onResult={setOutline} />
      )}
      {children}
    </CombLayoutContext.Provider>
  );
}

/**
 * Renders nothing. Finds whether the file has an outline: its kind from
 * `stat`, and for markdown its headings. The text query is the one the
 * markdown viewer reads, so the bytes load once.
 */
function OutlineProbe({
  file,
  probeKey,
  onResult,
}: {
  file: DrivePath;
  probeKey: string;
  onResult: (result: OutlineResult) => void;
}) {
  const stat = useAgentFsStat(file).data;
  // No version: not a file row (a folder URL without its "/" redirects).
  const kind =
    stat && stat.currentVersion !== undefined
      ? getFileKind(file.path, stat.contentType, stat.size)
      : null;
  useEffect(() => {
    if (kind && kind !== "markdown") {
      onResult({ key: probeKey, target: "plain", headings: NO_HEADINGS });
    }
  }, [kind, probeKey, onResult]);
  return kind === "markdown" ? (
    <MarkdownOutlineProbe file={file} probeKey={probeKey} onResult={onResult} />
  ) : null;
}

function MarkdownOutlineProbe({
  file,
  probeKey,
  onResult,
}: {
  file: DrivePath;
  probeKey: string;
  onResult: (result: OutlineResult) => void;
}) {
  const content = useAgentFsText(file);
  const text = content.data && !content.data.tooLarge ? content.data.text : null;
  const settled = content.data !== undefined || content.error !== null;
  const headings = useMemo(() => (text === null ? NO_HEADINGS : extractOutline(text)), [text]);
  useEffect(() => {
    if (!settled) return;
    onResult({ key: probeKey, target: hasOutline(headings) ? "outline" : "plain", headings });
  }, [settled, headings, probeKey, onResult]);
  return null;
}
